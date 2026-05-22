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
 * KIS API 응답 값을 안전하게 숫자로 변환
 * - 쉼표 포함 문자열("1,000,000") 올바르게 파싱
 * - null, undefined, 빈 문자열 → 0
 * - NaN → 0
 */
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
 * - 형식 검증: 숫자 10자리 (예: 50123456-01 또는 5012345601)
 * - 잘못된 형식은 API 호출 전에 차단하여 불필요한 네트워크 요청 방지
 */
function parseAccountNo(accountNo: string): { cano: string; productCode: string } {
  const normalized = accountNo.replace(/-/g, '').trim();
  if (!/^\d{10}$/.test(normalized)) {
    throw new Error(`계좌번호 형식이 올바르지 않습니다: "${accountNo}" (예: 50123456-01 또는 5012345601)`);
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
        // KIS 응답 기준으로 FID_ORG_ADJ_PRC는 invalid field로 확인됨.
        // 현재 사용 중인 서버는 FID_ORIG_ADJ_PRC를 요구한다.
        FID_ORIG_ADJ_PRC: '1',
      });

      console.log(`[KIS API] Daily candles request: ${stockCode}, base=${baseUrl}, period=${period}, date=${startDate}~${endDate}`);

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
        errors.push(`${baseUrl}: ${errorMsg}`);
        console.warn(`[KIS API] Daily candles failed on ${baseUrl}: ${stockCode} - ${errorMsg}`);
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
      };
    }

    return {
      orderNo: result.output?.ODNO || result.output?.KRX_FWDG_ORD_ORGNO || '',
      status: 'PENDING',
      message: result.msg1 || '주문 접수 완료',
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
      throw new Error(`잔고 조회 실패: ${response.status}`);
    }

    const result = await response.json();

    if (result.rt_cd !== '0') {
      throw new Error(`잔고 조회 에러: ${result.msg1}`);
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
    const url = `${this.baseUrl}/uapi/overseas-price/v1/quotations/price`;

    const params = new URLSearchParams({
      AUTH: '',
      EXCD: exchangeCode,
      SYMB: stockCode,
    });

    const trId = 'HHDFS00000300';

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
      stockCode,
      stockName: output.kor_name || output.name || stockCode,
      exchangeCode,
      exchangeName: exchangeNames[exchangeCode] || exchangeCode,
      currentPrice: parseFloat(output.last) || 0,
      previousClose: parseFloat(output.base) || 0,
      changePrice: parseFloat(output.diff) || 0,
      changeRate: parseFloat(output.rate) || 0,
      highPrice: parseFloat(output.high) || 0,
      lowPrice: parseFloat(output.low) || 0,
      openPrice: parseFloat(output.open) || 0,
      volume: parseInt(output.tvol) || 0,
      currency: 'USD',
      marketPrice: parseFloat(output.bid) || 0,
      afterHoursPrice: parseFloat(output.ask) || 0,
    };
  }

  async getOverseasDailyCandles(
    stockCode: string,
    exchangeCode: string = 'NAS',
    period: string = '1M'
  ): Promise<OverseasStockCandle[]> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/overseas-price/v1/quotations/dailyprice`;

    const periodMap: Record<string, string> = {
      '1W': '1W',
      '1M': '1M',
      '3M': '3M',
      '6M': '6M',
      '1Y': '1Y',
    };

    const params = new URLSearchParams({
      AUTH: '',
      EXCD: exchangeCode,
      SYMB: stockCode,
      GUBN: periodMap[period] || '1M',
      BYMD: '',
      MODP: '1',
    });

    const trId = 'HHDFS76240000';

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
      throw new Error(`해외주식 일봉 조회 실패: ${response.status}`);
    }

    const result = await response.json();

    if (result.rt_cd !== '0') {
      throw new Error(`해외주식 일봉 조회 에러: ${result.msg1}`);
    }

    const output2 = result.output2 || [];
    return output2.map((item: Record<string, string>) => ({
      date: item.xymd || '',
      open: parseFloat(item.open) || 0,
      high: parseFloat(item.high) || 0,
      low: parseFloat(item.low) || 0,
      close: parseFloat(item.clos) || 0,
      volume: parseInt(item.tvol) || 0,
      exchangeRate: parseFloat(item.rate) || 0,
    })).reverse();
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
      };
    }

    return {
      orderNo: result.output?.ODNO || result.output?.KRX_FWDG_ORD_ORGNO || '',
      status: 'PENDING',
      message: result.msg1 || '해외주식 주문 접수 완료',
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
      throw new Error(`해외주식 잔고 조회 실패: ${response.status}`);
    }

    const result = await response.json();

    if (result.rt_cd !== '0') {
      throw new Error(`해외주식 잔고 조회 에러: ${result.msg1}`);
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
