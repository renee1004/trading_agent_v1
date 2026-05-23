// 한국투자증권 KIS Open API 클라이언트
// REST API + WebSocket 실시간 시세 지원
// 국내주식 + 해외주식(미국 등) 지원

import {
  KisConfig,
  StockPrice,
  StockCandle,
  OrderRequest,
  OrderResponse,
  AccountBalance,
  BalanceItem,
  OverseasStockPrice,
  OverseasStockCandle,
  OverseasBalanceItem,
} from './types';
import { getDomesticSession } from './agent-scheduler';

const DEMO_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
const REAL_BASE_URL = 'https://openapi.koreainvestment.com:9443';

/**
 * 해외 종목코드 정규화
 * 워치리스트/잔고에서 오는 stockCode에 'NAS:RKLB' 같은 거래소 프리픽스가 포함될 수 있음
 * KIS API SYMB 파라미터는 순수 심볼만 허용 (예: 'RKLB', 'NVDA')
 *
 * @param stockCode - 원본 종목코드 ("NAS:RKLB" 또는 "RKLB")
 * @param exchangeCode - 거래소 코드 ("NAS", "NYS" 등). stockCode에 프리픽스가 있으면 그것을 우선 사용
 * @returns { exchangeCode, symbol, displayCode }
 */
export function normalizeOverseasSymbol(
  stockCode: string,
  exchangeCode: string = 'NAS'
): { exchangeCode: string; symbol: string; displayCode: string } {
  if (stockCode.includes(':')) {
    const parts = stockCode.split(':');
    const extractedExchange = parts[0];
    const extractedSymbol = parts[parts.length - 1];
    return {
      exchangeCode: extractedExchange || exchangeCode,
      symbol: extractedSymbol,
      displayCode: stockCode,
    };
  }
  return {
    exchangeCode,
    symbol: stockCode,
    displayCode: `${exchangeCode}:${stockCode}`,
  };
}

/**
 * KIS API 응답 값을 안전하게 숫자로 변환
 * - 쉼표 포함 문자열("1,000,000") 올바르게 파싱
 * - null, undefined, 빈 문자열 → 0
 * - NaN → 0
 */
/**
 * 계좌번호 마스킹 (로그용)
 * 전체 계좌번호를 노출하지 않고 앞 2자리 + **** + 뒤 2자리로 표시
 * 예: "5012345601" → "50****01"
 */
function maskAccountNo(accountNo: string): string {
  const normalized = accountNo.replace(/-/g, '');
  if (normalized.length <= 4) return '****';
  return normalized.substring(0, 2) + '****' + normalized.substring(normalized.length - 2);
}

function safeNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 날짜를 YYYYMMDD 형식으로 포맷
 */
function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * 기간 문자열(1M, 3M, 6M, 1Y 등)을 시작일/종료일로 변환
 * KIS 일봉 API는 FID_PERIOD_DIV_CODE에 '3M' 같은 값을 허용하지 않고
 * 실제 날짜 범위를 요구하므로 날짜를 계산해서 전달해야 함
 */
function getDateRangeByPeriod(period: string): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();

  switch (period) {
    case '1W':
      start.setDate(start.getDate() - 7);
      break;
    case '1M':
      start.setMonth(start.getMonth() - 1);
      break;
    case '3M':
      start.setMonth(start.getMonth() - 3);
      break;
    case '6M':
      start.setMonth(start.getMonth() - 6);
      break;
    case '1Y':
      start.setFullYear(start.getFullYear() - 1);
      break;
    default:
      start.setMonth(start.getMonth() - 1);
  }

  return {
    startDate: formatYmd(start),
    endDate: formatYmd(end),
  };
}

/**
 * 계좌번호 파서
 * - 하이픈 제거 후 CANO(8자리) + ACNT_PRDT_CD(2자리) 분리
 * - KIS API는 계좌번호를 두 필드로 나누어 전송
 * - 형식 검증:
 *   - 8자리 → 상품코드 '01' 자동 추가
 *   - 10자리 → 그대로 사용
 *   - 하이픈 포함 → 제거 후 검증 (예: 50123456-01 → 5012345601)
 * - 잘못된 형식은 API 호출 전에 차단하여 불필요한 네트워크 요청 방지
 */
function parseAccountNo(accountNo: string): { cano: string; productCode: string } {
  const normalizedRaw = accountNo.replace(/-/g, '').trim();
  const normalized = /^\d{8}$/.test(normalizedRaw)
    ? `${normalizedRaw}01`
    : normalizedRaw;

  if (!/^\d{10}$/.test(normalized)) {
    throw new Error(
      `계좌번호 형식이 올바르지 않습니다: "${accountNo}" (예: 50123456, 50123456-01 또는 5012345601)`
    );
  }
  return {
    cano: normalized.substring(0, 8),
    productCode: normalized.substring(8, 10),
  };
}

const serverTokenCache: {
  accessToken: string | null;
  tokenExpiresAt: Date | null;
  appKey: string | null;
} = {
  accessToken: null,
  tokenExpiresAt: null,
  appKey: null,
};

let tokenIssuancePromise: Promise<string> | null = null;

export class KisApiClient {
  private config: KisConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(config: KisConfig) {
    this.config = config;

    if (config.accessToken && config.tokenExpiresAt) {
      this.accessToken = config.accessToken;
      this.tokenExpiresAt = config.tokenExpiresAt;
      if (!serverTokenCache.accessToken || serverTokenCache.appKey === config.appKey) {
        serverTokenCache.accessToken = config.accessToken;
        serverTokenCache.tokenExpiresAt = config.tokenExpiresAt;
        serverTokenCache.appKey = config.appKey;
      }
    }

    if (!this.accessToken && serverTokenCache.accessToken && serverTokenCache.appKey === config.appKey) {
      this.accessToken = serverTokenCache.accessToken;
      this.tokenExpiresAt = serverTokenCache.tokenExpiresAt;
    }
  }

  private get baseUrl(): string {
    return this.config.isDemo ? DEMO_BASE_URL : REAL_BASE_URL;
  }

  private get quoteBaseUrls(): string[] {
    if (this.config.isDemo) {
      return [DEMO_BASE_URL, REAL_BASE_URL];
    }
    return [REAL_BASE_URL];
  }

  async issueToken(): Promise<string> {
    if (tokenIssuancePromise) {
      console.log('[KIS API] Token issuance already in progress, waiting...');
      const token = await tokenIssuancePromise;
      this.accessToken = serverTokenCache.accessToken;
      this.tokenExpiresAt = serverTokenCache.tokenExpiresAt;
      return this.accessToken || token;
    }

    tokenIssuancePromise = this._doIssueToken();
    try {
      return await tokenIssuancePromise;
    } finally {
      tokenIssuancePromise = null;
    }
  }

  private async _doIssueToken(): Promise<string> {
    const url = `${this.baseUrl}/oauth2/tokenP`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: this.config.appKey,
        appsecret: this.config.appSecret,
      }),
    });

    const responseText = await response.text();
    console.log(`[KIS API] Token response status: ${response.status}`);

    if (!response.ok) {
      let errorDetail = responseText;
      try {
        const errorJson = JSON.parse(responseText);
        errorDetail = `${errorJson.error_code || ''} - ${errorJson.error_description || responseText}`;
      } catch {}
      throw new Error(`KIS 토큰 발급 실패 (${response.status}): ${errorDetail}`);
    }

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(`KIS 토큰 응답 파싱 실패: ${responseText.substring(0, 100)}`);
    }

    if (data.error_code) {
      throw new Error(`KIS 토큰 에러: ${data.error_code} - ${data.error_description}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = new Date(Date.now() + (data.expires_in || 86400) * 1000);

    serverTokenCache.accessToken = this.accessToken;
    serverTokenCache.tokenExpiresAt = this.tokenExpiresAt;
    serverTokenCache.appKey = this.config.appKey;

    console.log(`[KIS API] Token cached, expires at: ${this.tokenExpiresAt.toISOString()}`);

    return this.accessToken!;
  }

  async ensureToken(): Promise<string> {
    const BUFFER_MS = 5 * 60 * 1000;
    if (this.accessToken && this.tokenExpiresAt && this.tokenExpiresAt.getTime() - BUFFER_MS > Date.now()) {
      return this.accessToken;
    }
    return this.issueToken();
  }

  getTokenInfo(): { accessToken: string | null; tokenExpiresAt: Date | null } {
    return {
      accessToken: this.accessToken,
      tokenExpiresAt: this.tokenExpiresAt,
    };
  }

  async createHashKey(data: string): Promise<string> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/hashkey`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        Authorization: `Bearer ${token}`,
      },
      body: data,
    });

    const result = await response.json();
    return result.HASH;
  }

  async getStockPrice(stockCode: string): Promise<StockPrice> {
    const token = await this.ensureToken();
    const errors: string[] = [];

    for (const baseUrl of this.quoteBaseUrls) {
      const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price`;
      const params = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
      });

      try {
        const response = await fetch(`${url}?${params.toString()}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appKey: this.config.appKey,
            appSecret: this.config.appSecret,
            tr_id: 'FHKST01010100',
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        if (result.rt_cd !== '0') {
          throw new Error(`${result.msg1 || '시세 조회 에러'} (rt_cd=${result.rt_cd}, msg_cd=${result.msg_cd || ''})`);
        }

        const output = result.output;
        return {
          stockCode,
          stockName: output.hts_kor_isnm || stockCode,
          currentPrice: parseInt(output.stck_prpr) || 0,
          previousClose: parseInt(output.stck_sdpr) || 0,
          changePrice: parseInt(output.prdy_vrss) || 0,
          changeRate: parseFloat(output.prdy_ctrt) || 0,
          highPrice: parseInt(output.stck_hgpr) || 0,
          lowPrice: parseInt(output.stck_lwpr) || 0,
          openPrice: parseInt(output.stck_oprc) || 0,
          volume: parseInt(output.acml_vol) || 0,
          tradingValue: parseInt(output.acml_tr_pbmn) || 0,
          market: 'DOMESTIC',
          currency: 'KRW',
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`${baseUrl}: ${errorMsg}`);
        console.warn(`[KIS API] Stock price failed on ${baseUrl}: ${stockCode} - ${errorMsg}`);
      }
    }

    throw new Error(`시세 조회 실패: ${errors.join(' | ')}`);
  }

  async getStockDailyCandles(
    stockCode: string,
    period: string = '1M'
  ): Promise<StockCandle[]> {
    const token = await this.ensureToken();
    const { startDate, endDate } = getDateRangeByPeriod(period);
    const errors: string[] = [];

    for (const baseUrl of this.quoteBaseUrls) {
      const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`;

      const params = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: stockCode,
        FID_INPUT_DATE_1: startDate,
        FID_INPUT_DATE_2: endDate,
        FID_PERIOD_DIV_CODE: 'D',
        FID_ORG_ADJ_PRC: '1',
      });

      console.log(`[KIS API] Daily candles request: stockCode=${stockCode}, base=${baseUrl}, date=${startDate}~${endDate}`);

      try {
        const response = await fetch(`${url}?${params.toString()}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appKey: this.config.appKey,
            appSecret: this.config.appSecret,
            tr_id: 'FHKST03010100',
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        const output2 = Array.isArray(result.output2) ? result.output2 : [];
        console.log('[KIS API] Daily candles response', {
          stockCode,
          baseUrl,
          rt_cd: result.rt_cd,
          msg_cd: result.msg_cd,
          msg1: result.msg1,
          output2Length: output2.length,
        });

        if (result.rt_cd !== '0') {
          throw new Error(`${result.msg1 || '일봉 조회 에러'} (rt_cd=${result.rt_cd}, msg_cd=${result.msg_cd || ''})`);
        }

        if (output2.length === 0) {
          throw new Error(`일봉 조회 성공했으나 output2가 비어 있음 (rt_cd=${result.rt_cd}, msg_cd=${result.msg_cd || ''})`);
        }

        console.log(`[KIS API] Daily candles 성공: stockCode=${stockCode}, candles=${output2.length}, base=${baseUrl}`);
        return output2.map((item: Record<string, string>) => ({
          date: item.stck_bsop_date || '',
          open: parseInt(item.stck_oprc) || 0,
          high: parseInt(item.stck_hgpr) || 0,
          low: parseInt(item.stck_lwpr) || 0,
          close: parseInt(item.stck_clpr) || 0,
          volume: parseInt(item.acml_vol) || 0,
        })).reverse();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`[${baseUrl}] ${errorMsg}`);
        console.warn(`[KIS API] Daily candles failed: stockCode=${stockCode}, baseUrl=${baseUrl}, error=${errorMsg}`);
      }
    }

    throw new Error(`일봉 조회 실패: ${errors.join(' | ')}`);
  }

  /**
   * 주식 매수/매도 주문 (국내)
   *
   * 주문구분코드(ORD_DVSN) 자동 선택:
   * - 정규장 (09:00~15:30): 시장가 '01' (기본)
   * - 장전 시간외 종가 (08:30~08:40): '61'
   * - 장후 시간외 종가 (15:40~16:00): '81'
   * - 시간외 단일가 (16:00~18:00): '62'
   * - 동시호가 (08:40~09:00): 지정가 '00'
   *
   * 호출자가 명시적으로 orderKind를 지정하면 그 값을 우선 사용
   */
  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    if (order.market === 'OVERSEAS' && order.exchangeCode) {
      return this.placeOverseasOrder(order);
    }

    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`;

    const trId = order.orderType === 'BUY'
      ? (this.config.isDemo ? 'VTTC0802U' : 'TTTC0802U')
      : (this.config.isDemo ? 'VTTC0801U' : 'TTTC0801U');

    // 현재 세션에 맞는 주문구분코드 자동 선택
    // order.orderKind가 '01' (기본 시장가)인 경우에만 세션 기반 자동 선택
    // 명시적으로 '00', '02' 등이 지정된 경우 그대로 사용
    let orderKind = order.orderKind;
    if (orderKind === '01') {
      const session = getDomesticSession();
      // 정규장이면 시장가('01') 그대로, 다른 세션이면 세션에 맞는 코드 사용
      if (session.session !== 'REGULAR' && session.session !== 'CLOSED') {
        orderKind = session.orderDivision;
        console.log(`[KIS API] 세션 자동 감지: ${session.label} → ORD_DVSN='${orderKind}'`);
      }
    }

    const account = parseAccountNo(this.config.accountNo);
    const orderData = {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      PDNO: order.stockCode,
      ORD_DVSN: orderKind,
      ORD_QTY: String(order.quantity),
      ORD_UNPR: String(order.price || 0),
    };

    const hashKey = await this.createHashKey(JSON.stringify(orderData));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        tr_id: trId,
        hashkey: hashKey,
      },
      body: JSON.stringify(orderData),
    });

    const result = await response.json();

    if (result.rt_cd !== '0') {
      return {
        orderNo: '',
        status: 'FAILED',
        message: result.msg1 || '주문 실패',
        rt_cd: result.rt_cd,
        msg_cd: result.msg_cd,
      };
    }

    return {
      orderNo: result.output?.ODNO || result.output?.KRX_FWDG_ORD_ORGNO || '',
      status: 'PENDING',
      message: result.msg1 || '주문 접수 완료',
      rt_cd: result.rt_cd,
      msg_cd: result.msg_cd,
    };
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance`;

    const account = parseAccountNo(this.config.accountNo);
    const params = new URLSearchParams({
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      AFHR_FLPR_YN: 'N',
      OFL_YN: '',
      INQR_DVSN: '02',
      UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N',
      PRCS_DVSN: '00',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    });

    const trId = this.config.isDemo ? 'VTTC8434R' : 'TTTC8434R';

    // 요청 상세 로그 (계좌번호 마스킹)
    console.log('[KIS API] Domestic balance request', {
      endpoint: '/uapi/domestic-stock/v1/trading/inquire-balance',
      tr_id: trId,
      accountMasked: maskAccountNo(this.config.accountNo),
      isDemo: this.config.isDemo,
      baseUrl: this.baseUrl,
      params: {
        CANO: account.cano.substring(0, 2) + '****' + account.cano.substring(6),
        ACNT_PRDT_CD: account.productCode,
        INQR_DVSN: '02',
        UNPR_DVSN: '01',
      },
    });

    const response = await fetch(`${url}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        tr_id: trId,
      },
    });

    if (!response.ok) {
      // HTTP 에러 시 response body에서 rt_cd/msg_cd/msg1 추출 시도
      let errorDetails: Record<string, unknown> = {
        httpStatus: response.status,
        statusText: response.statusText,
        endpoint: '/uapi/domestic-stock/v1/trading/inquire-balance',
        tr_id: trId,
        accountMasked: maskAccountNo(this.config.accountNo),
        isDemo: this.config.isDemo,
      };
      try {
        const errorBody = await response.json();
        errorDetails = {
          ...errorDetails,
          rt_cd: errorBody.rt_cd,
          msg_cd: errorBody.msg_cd,
          msg1: errorBody.msg1,
        };
        console.error('[KIS API] Domestic balance HTTP error with body', errorDetails);
        throw new Error(
          `잔고 조회 실패: HTTP ${response.status} (rt_cd=${errorBody.rt_cd ?? ''}, msg_cd=${errorBody.msg_cd ?? ''}, msg1=${errorBody.msg1 ?? ''})`
        );
      } catch (parseError) {
        // JSON 파싱 실패 시 원래 에러 throw
        if (parseError instanceof Error && parseError.message.includes('잔고 조회 실패')) {
          throw parseError;
        }
        console.error('[KIS API] Domestic balance HTTP error (body parse failed)', errorDetails);
        throw new Error(`잔고 조회 실패: HTTP ${response.status}`);
      }
    }

    const result = await response.json();

    if (result.rt_cd !== '0') {
      console.error('[KIS API] Domestic balance API error', {
        rt_cd: result.rt_cd,
        msg_cd: result.msg_cd,
        msg1: result.msg1,
        tr_id: trId,
        accountMasked: maskAccountNo(this.config.accountNo),
      });
      throw new Error(`잔고 조회 에러: ${result.msg1} (rt_cd=${result.rt_cd}, msg_cd=${result.msg_cd || ''})`);
    }

    const holdings = Array.isArray(result.output1) ? result.output1 : [];
    const summaryList = Array.isArray(result.output2) ? result.output2 : [];
    const summary = (summaryList[0] || {}) as Record<string, string>;

    const positions: BalanceItem[] = holdings
      .filter((item: Record<string, string>) => safeNumber(item.hldg_qty) > 0)
      .map((item: Record<string, string>) => ({
        stockCode: item.pdno || '',
        stockName: item.prdt_name || item.prdt_abrv_name || '',
        quantity: safeNumber(item.hldg_qty),
        avgPrice: safeNumber(item.pchs_avg_pric),
        currentPrice: safeNumber(item.prpr || item.stck_prpr),
        profitLoss: safeNumber(item.evlu_pfls_amt),
        profitRate: safeNumber(item.evlu_pfls_rt),
        evaluationAmount: safeNumber(item.evlu_amt),
        market: 'DOMESTIC' as const,
        currency: 'KRW',
      }));

    const stockEvaluation = safeNumber(summary.scts_evlu_amt);
    const totalEvaluation =
      safeNumber(summary.tot_evlu_amt) ||
      safeNumber(summary.nass_amt) ||
      stockEvaluation + safeNumber(summary.dnca_tot_amt);
    const totalProfitLoss =
      safeNumber(summary.evlu_pfls_smtl_amt) ||
      safeNumber(summary.tot_pfls);
    const purchaseAmount = safeNumber(summary.pchs_amt_smtl_amt);
    const totalProfitRate = purchaseAmount > 0
      ? (totalProfitLoss / purchaseAmount) * 100
      : safeNumber(summary.tot_pfls_rt);
    const availableAmount =
      safeNumber(summary.prvs_rcdl_excc_amt) ||
      safeNumber(summary.dnca_tot_amt) ||
      safeNumber(summary.nxdy_excc_amt);

    console.log('[KIS Client] getAccountBalance success', {
      totalEvaluation, availableAmount, positions: positions.length
    });

    return {
      totalDeposit: totalEvaluation,
      totalEvaluation,
      totalProfitLoss,
      totalProfitRate,
      availableAmount,
      positions,
    };
  }

  /**
   * 국내주식 주문체결내역 조회
   * 주문 후 체결 여부를 확인하기 위해 사용
   * KIS API: TTTC8001R (실전) / VTTC8001R (모의)
   * 엔드포인트: /uapi/domestic-stock/v1/trading/inquire-ccnl
   *
   * 반환값:
   * - 총체결수량, 총체결금액
   * - 체결상태: 접수/확인/체결/전량체결/취소/거부
   */
  async getOrderStatus(
    orderNo: string,
  ): Promise<{
    orderNo: string;
    stockCode: string;
    stockName: string;
    orderType: 'BUY' | 'SELL';
    orderQuantity: number;
    filledQuantity: number;
    filledPrice: number;
    status: 'PENDING' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED';
    rawStatus: string;
  }> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-ccnl`;

    const account = parseAccountNo(this.config.accountNo);
    const params = new URLSearchParams({
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      INQR_DVSN_1: '1',
      INQR_DVSN_2: '0',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    });

    // 주문번호가 있으면 특정 주문 조회
    if (orderNo) {
      params.set('ODNO', orderNo);
    }

    const trId = this.config.isDemo ? 'VTTC8001R' : 'TTTC8001R';

    try {
      const response = await fetch(`${url}?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appKey: this.config.appKey,
          appSecret: this.config.appSecret,
          tr_id: trId,
        },
      });

      const result = await response.json();

      if (result.rt_cd !== '0') {
        throw new Error(`주문체결 조회 에러: ${result.msg1}`);
      }

      const output1 = Array.isArray(result.output1) ? result.output1 : [];
      const order = output1.find((item: Record<string, string>) =>
        item.odno === orderNo || item.ord_no === orderNo
      );

      if (!order) {
        return {
          orderNo,
          stockCode: '',
          stockName: '',
          orderType: 'BUY',
          orderQuantity: 0,
          filledQuantity: 0,
          filledPrice: 0,
          status: 'PENDING',
          rawStatus: '조회불가',
        };
      }

      const filledQty = safeNumber(order.tot_ccld_qty || order.ccld_qty);
      const orderQty = safeNumber(order.ord_qty);
      const rawStatus = order.ord_dvsn_name || order.sll_buy_dvsn_cd || '';

      // 체결 상태 판별
      let status: 'PENDING' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED';
      if (filledQty === 0) {
        status = 'PENDING';
      } else if (filledQty < orderQty) {
        // 부분 체결 또는 취소 여부 확인
        const cnclYn = order.cncl_yn || '';
        if (cnclYn === 'Y') {
          status = 'CANCELLED';
        } else {
          status = 'PARTIAL';
        }
      } else {
        status = 'FILLED';
      }

      return {
        orderNo: order.odno || order.ord_no || orderNo,
        stockCode: order.pdno || order.stck_shrn_iscd || '',
        stockName: order.prdt_name || '',
        orderType: (order.sll_buy_dvsn_cd === '01' || order.ord_dvsn_cd === '01') ? 'BUY' : 'SELL',
        orderQuantity: orderQty,
        filledQuantity: filledQty,
        filledPrice: safeNumber(order.tot_ccld_amt || order.avg_prpr),
        status,
        rawStatus,
      };
    } catch (error) {
      console.error('[KIS API] 주문체결 조회 실패:', error);
      return {
        orderNo,
        stockCode: '',
        stockName: '',
        orderType: 'BUY',
        orderQuantity: 0,
        filledQuantity: 0,
        filledPrice: 0,
        status: 'PENDING',
        rawStatus: `조회실패: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  }

  /**
   * 미체결 주문 전체 조회
   * 대기 중인 주문을 확인하여 정리/취소 여부 판단
   */
  async getPendingOrders(): Promise<Array<{
    orderNo: string;
    stockCode: string;
    stockName: string;
    orderType: 'BUY' | 'SELL';
    orderQuantity: number;
    orderPrice: number;
    orderKind: string;
    orderTime: string;
  }>> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-psbl-order`;

    const account = parseAccountNo(this.config.accountNo);
    const params = new URLSearchParams({
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      INQR_DVSN_1: '0',
      INQR_DVSN_2: '0',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    });

    const trId = this.config.isDemo ? 'VTTC8001R' : 'TTTC8001R';

    try {
      const response = await fetch(`${url}?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appKey: this.config.appKey,
          appSecret: this.config.appSecret,
          tr_id: trId,
        },
      });

      const result = await response.json();

      if (result.rt_cd !== '0') {
        return [];
      }

      const output1 = Array.isArray(result.output1) ? result.output1 : [];
      return output1.map((item: Record<string, string>) => ({
        orderNo: item.odno || item.ord_no || '',
        stockCode: item.pdno || item.stck_shrn_iscd || '',
        stockName: item.prdt_name || '',
        orderType: (item.sll_buy_dvsn_cd === '01') ? 'BUY' : 'SELL',
        orderQuantity: safeNumber(item.ord_qty || item.tot_ccld_qty),
        orderPrice: safeNumber(item.ord_unpr || item.avg_prpr),
        orderKind: item.ord_dvsn_cd || '00',
        orderTime: item.ord_tmd || '',
      }));
    } catch (error) {
      console.error('[KIS API] 미체결 조회 실패:', error);
      return [];
    }
  }

  async cancelOrder(orderNo: string, stockCode: string, orderType: 'BUY' | 'SELL'): Promise<OrderResponse> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`;

    const trId = this.config.isDemo ? 'VTTC0803U' : 'TTTC0803U';

    const account = parseAccountNo(this.config.accountNo);
    const cancelData = {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      KRX_FWDG_ORD_ORGNO: orderNo,
      ORG_ODNO: orderNo,
      ORD_DVSN: '00',
      ORD_QTY: '0',
      ORD_UNPR: '0',
    };

    const hashKey = await this.createHashKey(JSON.stringify(cancelData));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        tr_id: trId,
        hashkey: hashKey,
      },
      body: JSON.stringify(cancelData),
    });

    const result = await response.json();

    return {
      orderNo: orderNo,
      status: result.rt_cd === '0' ? 'CANCELLED' : 'FAILED',
      message: result.msg1 || '취소 처리 결과',
    };
  }

  async getOverseasStockPrice(
    stockCode: string,
    exchangeCode: string = 'NAS'
  ): Promise<OverseasStockPrice> {
    const token = await this.ensureToken();
    const { exchangeCode: normExchange, symbol: pureSymbol, displayCode } = normalizeOverseasSymbol(stockCode, exchangeCode);
    const url = `${this.baseUrl}/uapi/overseas-price/v1/quotations/price`;

    const params = new URLSearchParams({
      AUTH: '',
      EXCD: normExchange,
      SYMB: pureSymbol,
    });

    const trId = 'HHDFS00000300';

    console.log('[KIS API] Overseas stock price request', {
      originalStockCode: stockCode,
      normalizedSymbol: pureSymbol,
      exchangeCode: normExchange,
      requestParams: { AUTH: '', EXCD: normExchange, SYMB: pureSymbol },
      tr_id: trId,
      baseUrl: this.baseUrl,
    });

    const response = await fetch(`${url}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        tr_id: trId,
      },
    });

    if (!response.ok) {
      throw new Error(`해외주식 시세 조회 실패: ${response.status}`);
    }

    const result = await response.json();

    if (result.rt_cd !== '0') {
      throw new Error(`해외주식 시세 조회 에러: ${result.msg1}`);
    }

    const output = result.output || {};

    // rawPriceFields: KIS API 응답 필드명 다양성 대비 fallback chain
    const rawPriceFields = {
      last:
        output.last ??
        output.last_price ??
        output.ovrs_nmix_prpr ??
        output.stck_prpr ??
        output.price ??
        null,
      base:
        output.base ??
        output.base_price ??
        output.ovrs_nmix_prdy_clpr ??
        output.prdy_clpr ??
        output.previousClose ??
        null,
      high:
        output.high ??
        output.high_price ??
        output.ovrs_nmix_hgpr ??
        output.stck_hgpr ??
        null,
      low:
        output.low ??
        output.low_price ??
        output.ovrs_nmix_lwpr ??
        output.stck_lwpr ??
        null,
    };

    // currentPrice는 반드시 rawPriceFields.last에서 파싱
    const currentPrice = safeNumber(rawPriceFields.last);
    const currentPriceField = 'last';

    if (currentPrice <= 0) {
      console.warn('[KIS API] Overseas stock price: last 필드가 비어 있거나 0', {
        originalStockCode: stockCode,
        normalizedSymbol: pureSymbol,
        exchangeCode: normExchange,
        rawPriceFields,
      });
    }

    // 응답 필드 매핑 검증 로그
    console.log('[KIS API] Overseas stock price response', {
      originalStockCode: stockCode,
      normalizedSymbol: pureSymbol,
      exchangeCode: normExchange,
      rt_cd: result.rt_cd,
      msg_cd: result.msg_cd,
      msg1: result.msg1,
      outputKeys: Object.keys(output),
      rawPriceFields,
      currentPriceField,
      parsedCurrentPrice: currentPrice,
      parsedPreviousClose: safeNumber(rawPriceFields.base),
      parsedVolume: safeNumber(output.volume ?? output.tvol ?? output.acml_vol ?? output.trde_qty),
      lastIsZero: currentPrice === 0,
      timestamp: new Date().toISOString(),
    });

    const exchangeNames: Record<string, string> = {
      'NAS': '나스닥',
      'NYS': '뉴욕',
      'AMS': '아멕스',
      'TKS': '도쿄',
      'HKS': '홍콩',
      'SHS': '상해',
      'SZS': '심천',
    };

    return {
      stockCode: displayCode,
      originalStockCode: stockCode,
      normalizedSymbol: pureSymbol,
      currentPriceField,
      rawPriceFields,
      stockName: output.kor_name || output.name || pureSymbol,
      exchangeCode: normExchange,
      exchangeName: exchangeNames[normExchange] || normExchange,
      currentPrice,
      previousClose: safeNumber(rawPriceFields.base),
      changePrice: safeNumber(output.diff),
      changeRate: safeNumber(output.rate),
      highPrice: safeNumber(rawPriceFields.high),
      lowPrice: safeNumber(rawPriceFields.low),
      openPrice: safeNumber(output.open),
      volume: safeNumber(output.volume ?? output.tvol ?? output.acml_vol ?? output.trde_qty),
      currency: 'USD',
      marketPrice: safeNumber(output.bid),
      afterHoursPrice: safeNumber(output.ask),
      source: 'KIS_REST',
    };
  }

  /**
   * 해외주식 현재가 간이 조회 (주문 전 실시간 검증용)
   * getOverseasStockPrice()와 동일한 API를 사용하되,
   * 주문 전 가격 검증에 필요한 최소 정보만 반환
   *
   * 반환값에 timestamp와 source를 포함하여
   * 분석 시점과 주문 시점의 가격 차이를 추적 가능
   *
   * KIS 해외현재가 API (HHDFS00000300) 응답 필드 매핑:
   * - output.last: 현재가 (최근 체결가) → currentPrice
   * - output.base: 기준가 (전일 종가) → previousClose
   * - output.diff: 대비 (전일 대비 변동) → changePrice
   * - output.rate: 등락률 (%) → changeRate
   * - output.high: 고가
   * - output.low: 저가
   * - output.open: 시가
   * - output.tvol: 거래량
   * - output.bid: 매수호가
   * - output.ask: 매도호가
   */
  async getOverseasCurrentPrice(
    stockCode: string,
    exchangeCode: string = 'NAS'
  ): Promise<{
    stockCode: string;
    originalStockCode: string;
    exchangeCode: string;
    normalizedSymbol: string;
    currentPrice: number;
    currentPriceField: string;
    rawPriceFields: {
      last: unknown;
      base: unknown;
      high: unknown;
      low: unknown;
    };
    previousClose: number;
    highPrice: number;
    lowPrice: number;
    volume: number;
    currency: string;
    timestamp: string;
    source: string;
  }> {
    const token = await this.ensureToken();
    const { exchangeCode: normExchange, symbol: pureSymbol, displayCode } = normalizeOverseasSymbol(stockCode, exchangeCode);
    const url = `${this.baseUrl}/uapi/overseas-price/v1/quotations/price`;

    const params = new URLSearchParams({
      AUTH: '',
      EXCD: normExchange,
      SYMB: pureSymbol,
    });

    const trId = 'HHDFS00000300';

    // 요청 상세 로그
    console.log('[KIS API] Overseas current price request', {
      originalStockCode: stockCode,
      normalizedSymbol: pureSymbol,
      exchangeCode: normExchange,
      requestParams: { AUTH: '', EXCD: normExchange, SYMB: pureSymbol },
      tr_id: trId,
      baseUrl: this.baseUrl,
    });

    const response = await fetch(`${url}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        tr_id: trId,
      },
    });

    if (!response.ok) {
      throw new Error(`해외주식 현재가 조회 실패: ${response.status}`);
    }

    const result = await response.json();

    if (result.rt_cd !== '0') {
      throw new Error(`해외주식 현재가 조회 에러: ${result.msg1}`);
    }

    const output = result.output || {};

    // rawPriceFields: KIS API 응답 필드명 다양성 대비 fallback chain
    const rawPriceFields = {
      last:
        output.last ??
        output.last_price ??
        output.ovrs_nmix_prpr ??
        output.stck_prpr ??
        output.price ??
        null,
      base:
        output.base ??
        output.base_price ??
        output.ovrs_nmix_prdy_clpr ??
        output.prdy_clpr ??
        output.previousClose ??
        null,
      high:
        output.high ??
        output.high_price ??
        output.ovrs_nmix_hgpr ??
        output.stck_hgpr ??
        null,
      low:
        output.low ??
        output.low_price ??
        output.ovrs_nmix_lwpr ??
        output.stck_lwpr ??
        null,
    };

    // currentPrice는 반드시 rawPriceFields.last에서 파싱
    const currentPrice = safeNumber(rawPriceFields.last);
    const currentPriceField = 'last';

    // last가 없거나 0이면 에러 throw (현재가 사용 불가)
    if (currentPrice <= 0) {
      console.error('[KIS API] Overseas current price: last 필드가 비어 있거나 0', {
        originalStockCode: stockCode,
        normalizedSymbol: pureSymbol,
        exchangeCode: normExchange,
        rawPriceFields,
      });
      throw new Error(
        `해외 현재가 조회 실패: last 필드가 비어 있거나 0입니다. symbol=${pureSymbol}, exchange=${normExchange}`
      );
    }

    // 응답 원문 필드 검증 로그 (민감정보 제외)
    console.log('[KIS API] Overseas current price response', {
      originalStockCode: stockCode,
      normalizedSymbol: pureSymbol,
      exchangeCode: normExchange,
      rt_cd: result.rt_cd,
      msg_cd: result.msg_cd,
      msg1: result.msg1,
      outputKeys: Object.keys(output),
      rawPriceFields,
      currentPriceField,
      parsedCurrentPrice: currentPrice,
      parsedPreviousClose: safeNumber(rawPriceFields.base),
      parsedVolume: safeNumber(output.volume ?? output.tvol ?? output.acml_vol ?? output.trde_qty),
      timestamp: new Date().toISOString(),
    });

    return {
      stockCode: displayCode,
      originalStockCode: stockCode,
      exchangeCode: normExchange,
      normalizedSymbol: pureSymbol,
      currentPrice,
      currentPriceField,
      rawPriceFields,
      previousClose: safeNumber(rawPriceFields.base),
      highPrice: safeNumber(rawPriceFields.high),
      lowPrice: safeNumber(rawPriceFields.low),
      volume: safeNumber(output.volume ?? output.tvol ?? output.acml_vol ?? output.trde_qty),
      currency: 'USD',
      timestamp: new Date().toISOString(),
      source: 'KIS_REST',
    };
  }

  /**
   * 해외주식 기간별시세(일/주/월) 조회
   * KIS API: HHDFS76240000
   * 
   * GUBN: 1글자 코드만 허용 ('0'=일봉, '1'=주봉, '2'=월봉)
   *   - '3M', '6M' 등 2글자 값을 보내면 WRONG VALUE SIZE 에러 발생
   *   - period는 BYMD 계산용으로만 사용, GUBN에는 항상 1글자 코드 입력
   * BYMD: 조회 기준일 (YYYYMMDD), 빈 값이면 당일 기준
   * MODP: 수정주가 여부 ('0'=수정주가, '1'=원주가)
   * 
   * dual-server fallback 적용:
   *   - 모의투자 서버 실패 시 실전 서버로 재시도
   *   - 상세 에러 로깅 (rt_cd, msg_cd, msg1, output2Length, 요청 파라미터)
   */
  async getOverseasDailyCandles(
    stockCode: string,
    exchangeCode: string = 'NAS',
    period: string = '1M'
  ): Promise<OverseasStockCandle[]> {
    const token = await this.ensureToken();
    const errors: string[] = [];

    // KIS 해외 일봉 API GUBN 파라미터는 1글자 코드만 허용:
    // '0' = 일봉, '1' = 주봉, '2' = 월봉
    // period는 BYMD 기준일 계산에만 사용, GUBN에는 항상 1글자 코드
    const gubnMap: Record<string, string> = {
      '1W': '1',   // 주봉
      '1M': '0',   // 일봉 (1개월치)
      '3M': '0',   // 일봉 (3개월치)
      '6M': '0',   // 일봉 (6개월치)
      '1Y': '0',   // 일봉 (1년치)
    };
    const gubn = gubnMap[period] || '0';

    // BYMD: 조회 기준일 (YYYYMMDD)
    // period가 길수록 과거 데이터를 더 많이 가져오도록 BYMD를 과거로 설정
    let bymdDate = new Date();
    switch (period) {
      case '3M': bymdDate.setMonth(bymdDate.getMonth() - 3); break;
      case '6M': bymdDate.setMonth(bymdDate.getMonth() - 6); break;
      case '1Y': bymdDate.setFullYear(bymdDate.getFullYear() - 1); break;
      default: break; // 1M, 1W 등은 당일 기준
    }
    const bymd = formatYmd(bymdDate);

    // 해외 종목코드 정규화 (프리픽스 제거)
    // KIS API SYMB 파라미터는 순수 심볼만 허용 (예: 'TSLA', 'NVDA')
    const { exchangeCode: normExchange, symbol: pureSymbol, displayCode } = normalizeOverseasSymbol(stockCode, exchangeCode);

    const params = new URLSearchParams({
      AUTH: '',
      EXCD: normExchange,
      SYMB: pureSymbol,
      GUBN: gubn,
      BYMD: bymd,
      MODP: '1',
    });

    const trId = 'HHDFS76240000';

    for (const baseUrl of this.quoteBaseUrls) {
      const url = `${baseUrl}/uapi/overseas-price/v1/quotations/dailyprice`;

      console.log(`[KIS API] Overseas daily candles request: stockCode=${stockCode}, pureSymbol=${pureSymbol}, EXCD=${normExchange}, GUBN=${gubn}, BYMD=${bymd}, base=${baseUrl}`);

      try {
        const response = await fetch(`${url}?${params.toString()}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appKey: this.config.appKey,
            appSecret: this.config.appSecret,
            tr_id: trId,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        const output2 = Array.isArray(result.output2) ? result.output2 : [];

        console.log('[KIS API] Overseas daily candles response', {
          stockCode,
          pureSymbol,
          exchangeCode: normExchange,
          baseUrl,
          rt_cd: result.rt_cd,
          msg_cd: result.msg_cd,
          msg1: result.msg1,
          output2Length: output2.length,
          GUBN: gubn,
          BYMD: bymd,
          MODP: '1',
        });

        if (result.rt_cd !== '0') {
          throw new Error(`${result.msg1 || '해외주식 일봉 조회 에러'} (rt_cd=${result.rt_cd}, msg_cd=${result.msg_cd || ''})`);
        }

        if (output2.length === 0) {
          throw new Error(`해외주식 일봉 조회 성공했으나 output2가 비어 있음 (rt_cd=${result.rt_cd}, msg_cd=${result.msg_cd || ''})`);
        }

        return output2.map((item: Record<string, string>) => ({
          date: item.xymd || '',
          open: parseFloat(item.open) || 0,
          high: parseFloat(item.high) || 0,
          low: parseFloat(item.low) || 0,
          close: parseFloat(item.clos) || 0,
          volume: parseInt(item.tvol) || 0,
          exchangeRate: parseFloat(item.rate) || 0,
        })).reverse();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`[${baseUrl}] ${errorMsg}`);
        console.warn(`[KIS API] Overseas daily candles failed: stockCode=${stockCode}, EXCD=${normExchange}, baseUrl=${baseUrl}, error=${errorMsg}`);
      }
    }

    throw new Error(`해외주식 일봉 조회 실패: ${errors.join(' | ')}`);
  }

  async placeOverseasOrder(order: OrderRequest): Promise<OrderResponse> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/overseas-stock/v1/trading/order`;

    const trId = order.orderType === 'BUY'
      ? (this.config.isDemo ? 'VTTT1002U' : 'TTTT1002U')
      : (this.config.isDemo ? 'VTTT1001U' : 'TTTT1001U');

    const account = parseAccountNo(this.config.accountNo);
    const orderData = {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      OVRS_EXCG_CD: order.exchangeCode || 'NAS',
      PDNO: order.stockCode,
      ORD_QTY: String(order.quantity),
      OVRS_ORD_UNPR: String(order.price || 0),
      ORD_SVR_DVSN_CD: '0',
      ORD_DVSN: order.orderKind || '00',
    };

    const hashKey = await this.createHashKey(JSON.stringify(orderData));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        tr_id: trId,
        hashkey: hashKey,
      },
      body: JSON.stringify(orderData),
    });

    const result = await response.json();

    if (result.rt_cd !== '0') {
      return {
        orderNo: '',
        status: 'FAILED',
        message: result.msg1 || '해외주식 주문 실패',
        rt_cd: result.rt_cd,
        msg_cd: result.msg_cd,
      };
    }

    return {
      orderNo: result.output?.ODNO || result.output?.KRX_FWDG_ORD_ORGNO || '',
      status: 'PENDING',
      message: result.msg1 || '해외주식 주문 접수 완료',
      rt_cd: result.rt_cd,
      msg_cd: result.msg_cd,
    };
  }

  async getOverseasAccountBalance(): Promise<{
    totalDeposit: number;
    totalEvaluation: number;
    totalProfitLoss: number;
    totalProfitRate: number;
    availableAmount: number;
    positions: OverseasBalanceItem[];
  }> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/overseas-stock/v1/trading/inquire-balance`;

    const account = parseAccountNo(this.config.accountNo);
    const params = new URLSearchParams({
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      OVRS_EXCG_CD: 'NAS',
      TR_CRCY_CD: 'USD',
      CTX_AREA_FK200: '',
      CTX_AREA_NK200: '',
    });

    const trId = this.config.isDemo ? 'VTTS3012R' : 'TTTS3012R';

    // 요청 상세 로그 (계좌번호 마스킹)
    console.log('[KIS API] Overseas balance request', {
      endpoint: '/uapi/overseas-stock/v1/trading/inquire-balance',
      tr_id: trId,
      accountMasked: maskAccountNo(this.config.accountNo),
      isDemo: this.config.isDemo,
      baseUrl: this.baseUrl,
      params: {
        CANO: account.cano.substring(0, 2) + '****' + account.cano.substring(6),
        ACNT_PRDT_CD: account.productCode,
        OVRS_EXCG_CD: 'NAS',
        TR_CRCY_CD: 'USD',
      },
    });

    const response = await fetch(`${url}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        tr_id: trId,
      },
    });

    if (!response.ok) {
      // HTTP 에러 시 response body에서 rt_cd/msg_cd/msg1 추출 시도
      let errorDetails: Record<string, unknown> = {
        httpStatus: response.status,
        statusText: response.statusText,
        endpoint: '/uapi/overseas-stock/v1/trading/inquire-balance',
        tr_id: trId,
        accountMasked: maskAccountNo(this.config.accountNo),
        isDemo: this.config.isDemo,
      };
      try {
        const errorBody = await response.json();
        errorDetails = {
          ...errorDetails,
          rt_cd: errorBody.rt_cd,
          msg_cd: errorBody.msg_cd,
          msg1: errorBody.msg1,
        };
        console.error('[KIS API] Overseas balance HTTP error with body', errorDetails);
        throw new Error(
          `해외주식 잔고 조회 실패: HTTP ${response.status} (rt_cd=${errorBody.rt_cd ?? ''}, msg_cd=${errorBody.msg_cd ?? ''}, msg1=${errorBody.msg1 ?? ''})`
        );
      } catch (parseError) {
        // JSON 파싱 실패 시 원래 에러 throw
        if (parseError instanceof Error && parseError.message.includes('해외주식 잔고 조회 실패')) {
          throw parseError;
        }
        console.error('[KIS API] Overseas balance HTTP error (body parse failed)', errorDetails);
        throw new Error(`해외주식 잔고 조회 실패: HTTP ${response.status}`);
      }
    }

    const result = await response.json();

    if (result.rt_cd !== '0') {
      // 해외 잔고 조회 API 에러 상세 로그 (민감정보 제외)
      console.error('[KIS API] Overseas balance API error', {
        endpoint: '/uapi/overseas-stock/v1/trading/inquire-balance',
        tr_id: trId,
        accountMasked: maskAccountNo(this.config.accountNo),
        rt_cd: result.rt_cd,
        msg_cd: result.msg_cd,
        msg1: result.msg1,
      });
      throw new Error(`해외주식 잔고 조회 에러: ${result.msg1} (rt_cd=${result.rt_cd}, msg_cd=${result.msg_cd || ''})`);
    }

    const holdings = Array.isArray(result.output1) ? result.output1 : [];
    const summaryList = Array.isArray(result.output2) ? result.output2 : [];
    const summary = (summaryList[0] || {}) as Record<string, string>;

    const exchangeNames: Record<string, string> = {
      'NAS': '나스닥',
      'NYS': '뉴욕',
      'AMS': '아멕스',
      'TKS': '도쿄',
      'HKS': '홍콩',
      'SHS': '상해',
      'SZS': '심천',
    };

    const positions: OverseasBalanceItem[] = holdings
      .filter((item: Record<string, string>) => safeNumber(item.ovrs_cblc_qty) > 0)
      .map((item: Record<string, string>) => ({
        stockCode: item.ovrs_pdno || '',
        stockName: item.ovrs_item_name || '',
        exchangeCode: item.ovrs_excg_cd || '',
        exchangeName: exchangeNames[item.ovrs_excg_cd] || item.ovrs_excg_cd,
        quantity: safeNumber(item.ovrs_cblc_qty),
        avgPrice: safeNumber(item.pchs_avg_pric),
        currentPrice: safeNumber(item.now_pric2),
        profitLoss: safeNumber(item.evlu_pfls_amt),
        profitRate: safeNumber(item.evlu_pfls_rt),
        evaluationAmount: safeNumber(item.evlu_amt),
        foreignEvaluation: safeNumber(item.frcr_evlu_amt),
        exchangeRate: safeNumber(item.bass_exrt) || 1,
        currency: item.tr_crcy_cd || 'USD',
        purchaseAmount: safeNumber(item.frcr_pchs_amt1),
      }));

    const totalEvaluation = safeNumber(summary.tot_evlu_amt);
    const totalProfitLoss = safeNumber(summary.tot_pfls);
    const purchaseAmount = positions.reduce((sum, p) => sum + Math.floor(p.purchaseAmount * p.exchangeRate), 0);
    const totalProfitRate = purchaseAmount > 0 ? (totalProfitLoss / purchaseAmount) * 100 : safeNumber(summary.tot_pfls_rt);
    const availableAmount =
      safeNumber(summary.prvs_rcdl_excc_amt) ||
      safeNumber(summary.wtch_amt) ||
      safeNumber(summary.dnca_tot_amt);

    console.log('[KIS Client] getOverseasAccountBalance success', {
      totalEvaluation, availableAmount, positions: positions.length
    });

    return {
      totalDeposit: totalEvaluation,
      totalEvaluation,
      totalProfitLoss,
      totalProfitRate,
      availableAmount,
      positions,
    };
  }

  async cancelOverseasOrder(
    orderNo: string,
    exchangeCode: string = 'NAS'
  ): Promise<OrderResponse> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/overseas-stock/v1/trading/order`;
    
    // 해외주식 주문취소 TR ID
    const trId = this.config.isDemo ? 'VTTT1004U' : 'TTTT1004U';

    const account = parseAccountNo(this.config.accountNo);
    const cancelData = {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      OVRS_EXCG_CD: exchangeCode,
      ORG_ODNO: orderNo,
      ORD_DVSN: '00',
      ORD_QTY: '0',
      OVRS_ORD_UNPR: '0',
    };

    const hashKey = await this.createHashKey(JSON.stringify(cancelData));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        tr_id: trId,
        hashkey: hashKey,
      },
      body: JSON.stringify(cancelData),
    });

    const result = await response.json();

    return {
      orderNo: orderNo,
      status: result.rt_cd === '0' ? 'CANCELLED' : 'FAILED',
      message: result.msg1 || '해외주식 취소 처리 결과',
    };
  }

  async searchOverseasStock(
    keyword: string,
    exchangeCode: string = 'NAS'
  ): Promise<Array<{
    code: string;
    name: string;
    nameEng: string;
    exchangeCode: string;
    sector: string;
  }>> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/overseas-price/v1/quotations/search-info`;

    const params = new URLSearchParams({
      AUTH: '',
      EXCD: exchangeCode,
      CO_YN_PRICECUR: '0',
      CO_STCK_SHRN_ISCD: keyword.toUpperCase(),
    });

    const trId = 'CTPF1702R';

    const response = await fetch(`${url}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        tr_id: trId,
      },
    });

    if (!response.ok) {
      throw new Error(`해외주식 검색 실패: ${response.status}`);
    }

    const result = await response.json();

    if (result.rt_cd !== '0') {
      return [];
    }

    const output = result.output || [];
    if (Array.isArray(output)) {
      return output.map((item: Record<string, string>) => ({
        code: item.symb || item.stck_shrn_iscd || '',
        name: item.knam || item.name || '',
        nameEng: item.enam || item.eng_name || '',
        exchangeCode: item.excd || exchangeCode,
        sector: item.sect || '',
      }));
    }

    if (output.symb || output.stck_shrn_iscd) {
      return [{
        code: output.symb || output.stck_shrn_iscd || '',
        name: output.knam || output.name || '',
        nameEng: output.enam || output.eng_name || '',
        exchangeCode: output.excd || exchangeCode,
        sector: output.sect || '',
      }];
    }

    return [];
  }
}
