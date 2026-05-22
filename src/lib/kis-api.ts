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

const DEMO_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
const REAL_BASE_URL = 'https://openapi.koreainvestment.com:9443';

// 서버 사이드 토큰 캐시 - 프로세스 내에서 토큰 재사용
// KisApiClient 인스턴스가 매번 새로 생성되어도 이 캐시를 통해 토큰 공유
const serverTokenCache: {
  accessToken: string | null;
  tokenExpiresAt: Date | null;
  appKey: string | null;  // 어떤 appKey의 토큰인지 추적
} = {
  accessToken: null,
  tokenExpiresAt: null,
  appKey: null,
};

// 토큰 발급 뮤텍스 - 동시에 여러 요청이 들어와도 1회만 발급
let tokenIssuancePromise: Promise<string> | null = null;

export class KisApiClient {
  private config: KisConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(config: KisConfig) {
    this.config = config;
    
    // 1. 생성자로 전달된 토큰 사용
    if (config.accessToken && config.tokenExpiresAt) {
      this.accessToken = config.accessToken;
      this.tokenExpiresAt = config.tokenExpiresAt;
      // 서버 캐시에도 동기화
      if (!serverTokenCache.accessToken || serverTokenCache.appKey === config.appKey) {
        serverTokenCache.accessToken = config.accessToken;
        serverTokenCache.tokenExpiresAt = config.tokenExpiresAt;
        serverTokenCache.appKey = config.appKey;
      }
    }
    
    // 2. 인스턴스에 토큰이 없으면 서버 캐시에서 복원
    if (!this.accessToken && serverTokenCache.accessToken && serverTokenCache.appKey === config.appKey) {
      this.accessToken = serverTokenCache.accessToken;
      this.tokenExpiresAt = serverTokenCache.tokenExpiresAt;
    }
  }

  private get baseUrl(): string {
    return this.config.isDemo ? DEMO_BASE_URL : REAL_BASE_URL;
  }

  /**
   * 접근 토큰 발급 (24시간 유효)
   * 뮤텍스 적용: 동시에 여러 요청이 들어와도 1회만 KIS API 호출
   */
  async issueToken(): Promise<string> {
    // 뮤텍스: 이미 발급 중이면 기다리기
    if (tokenIssuancePromise) {
      console.log('[KIS API] Token issuance already in progress, waiting...');
      const token = await tokenIssuancePromise;
      // 발급 완료 후 캐시에서 가져오기
      this.accessToken = serverTokenCache.accessToken;
      this.tokenExpiresAt = serverTokenCache.tokenExpiresAt;
      return this.accessToken!;
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
    
    // KIS API는 form-urlencoded 대신 JSON 바디도 지원
    // App Secret의 특수문자(+, =, /)가 인코딩 문제를 일으킬 수 있어 JSON 사용
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
    console.log(`[KIS API] Token response body: ${responseText.substring(0, 200)}`);

    if (!response.ok) {
      // 에러 응답에서 상세 정보 추출
      let errorDetail = responseText;
      try {
        const errorJson = JSON.parse(responseText);
        errorDetail = `${errorJson.error_code || ''} - ${errorJson.error_description || responseText}`;
      } catch (e) {}
      throw new Error(`KIS 토큰 발급 실패 (${response.status}): ${errorDetail}`);
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`KIS 토큰 응답 파싱 실패: ${responseText.substring(0, 100)}`);
    }
    
    if (data.error_code) {
      throw new Error(`KIS 토큰 에러: ${data.error_code} - ${data.error_description}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = new Date(Date.now() + (data.expires_in || 86400) * 1000);
    
    // 서버 캐시 업데이트
    serverTokenCache.accessToken = this.accessToken;
    serverTokenCache.tokenExpiresAt = this.tokenExpiresAt;
    serverTokenCache.appKey = this.config.appKey;
    
    console.log(`[KIS API] Token cached, expires at: ${this.tokenExpiresAt.toISOString()}`);
    
    return this.accessToken!;
  }

  /**
   * 유효한 토큰 확인 및 갱신
   */
  async ensureToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiresAt && this.tokenExpiresAt > new Date()) {
      return this.accessToken;
    }
    return this.issueToken();
  }

  /**
   * Hash Key 생성 (주문 시 필요)
   */
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

  // ========================================
  // 국내주식 API
  // ========================================

  /**
   * 주식 현재가 조회 (국내)
   */
  async getStockPrice(stockCode: string): Promise<StockPrice> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price`;
    
    const params = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: stockCode,
    });

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
      throw new Error(`시세 조회 실패: ${response.status}`);
    }

    const result = await response.json();
    
    if (result.rt_cd !== '0') {
      throw new Error(`시세 조회 에러: ${result.msg1}`);
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
  }

  /**
   * 주식 일봉 데이터 조회 (국내)
   */
  async getStockDailyCandles(
    stockCode: string, 
    period: string = '1M'
  ): Promise<StockCandle[]> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`;
    
    const params = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: stockCode,
      FID_INPUT_DATE_1: '',
      FID_INPUT_DATE_2: '',
      FID_PERIOD_DIV_CODE: period,
      FID_ORIG_ADJ_PRC: '1', // 수정주가
    });

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
      throw new Error(`일봉 조회 실패: ${response.status}`);
    }

    const result = await response.json();
    
    if (result.rt_cd !== '0') {
      throw new Error(`일봉 조회 에러: ${result.msg1}`);
    }

    const output2 = result.output2 || [];
    return output2.map((item: Record<string, string>) => ({
      date: item.stck_bsop_date || '',
      open: parseInt(item.stck_oprc) || 0,
      high: parseInt(item.stck_hgpr) || 0,
      low: parseInt(item.stck_lwpr) || 0,
      close: parseInt(item.stck_clpr) || 0,
      volume: parseInt(item.acml_vol) || 0,
    })).reverse();
  }

  /**
   * 주식 매수/매도 주문 (국내)
   */
  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    // 해외주식 주문인 경우 위임
    if (order.market === 'OVERSEAS' && order.exchangeCode) {
      return this.placeOverseasOrder(order);
    }

    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`;
    
    const trId = order.orderType === 'BUY' 
      ? (this.config.isDemo ? 'VTTC0802U' : 'TTTC0802U')
      : (this.config.isDemo ? 'VTTC0801U' : 'TTTC0801U');

    const orderData = {
      CANO: this.config.accountNo.substring(0, 8),
      ACNT_PRDT_CD: this.config.accountNo.substring(8) || '01',
      PDNO: order.stockCode,
      ORD_DVSN: order.orderKind,
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

  /**
   * 계좌 잔고 조회 (국내)
   */
  async getAccountBalance(): Promise<AccountBalance> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance`;
    
    const params = new URLSearchParams({
      CANO: this.config.accountNo.substring(0, 8),
      ACNT_PRDT_CD: this.config.accountNo.substring(8) || '01',
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

    const output1 = result.output1 || {};
    const output2 = result.output2 || [];

    const positions: BalanceItem[] = output2.map((item: Record<string, string>) => ({
      stockCode: item.pdno || '',
      stockName: item.prdt_name || '',
      quantity: parseInt(item.hldg_qty) || 0,
      avgPrice: parseInt(item.pchs_avg_pric) || 0,
      currentPrice: parseInt(item.stck_prpr) || 0,
      profitLoss: parseInt(item.evlu_pfls_amt) || 0,
      profitRate: parseFloat(item.evlu_pfls_rt) || 0,
      evaluationAmount: parseInt(item.evlu_amt) || 0,
      market: 'DOMESTIC' as const,
      currency: 'KRW',
    }));

    return {
      totalDeposit: parseInt(output1.dnca_tot_amt) || 0,
      totalEvaluation: parseInt(output1.tot_evlu_amt) || 0,
      totalProfitLoss: parseInt(output1.tot_pfls) || 0,
      totalProfitRate: parseFloat(output1.tot_pfls_rt) || 0,
      availableAmount: parseInt(output1.prvs_rcdl_excc_amt) || 0,
      positions,
    };
  }

  /**
   * 주문 취소 (국내)
   */
  async cancelOrder(orderNo: string, stockCode: string, orderType: 'BUY' | 'SELL'): Promise<OrderResponse> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`;
    
    const trId = this.config.isDemo ? 'VTTC0803U' : 'TTTC0803U';

    const cancelData = {
      CANO: this.config.accountNo.substring(0, 8),
      ACNT_PRDT_CD: this.config.accountNo.substring(8) || '01',
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

  // ========================================
  // 해외주식 API (미국 등)
  // ========================================

  /**
   * 해외주식 현재가 조회
   * 거래소코드: NAS(나스닥), NYS(뉴욕), AMS(아멕스)
   */
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

    // 거래소명 매핑
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

  /**
   * 해외주식 일봉 데이터 조회
   */
  async getOverseasDailyCandles(
    stockCode: string,
    exchangeCode: string = 'NAS',
    period: string = '1M'
  ): Promise<OverseasStockCandle[]> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/overseas-price/v1/quotations/dailyprice`;
    
    // 기간 코드 변환
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
      MODP: '1', // 수정주가
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

  /**
   * 해외주식 매수/매도 주문
   * 거래소코드: NAS(나스닥), NYS(뉴욕), AMS(아멕스)
   * 주문구분: 00(지정가), 32(LOO), 34(LOC), MOO(장전시장가), MOC(장후시장가)
   */
  async placeOverseasOrder(order: OrderRequest): Promise<OrderResponse> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/overseas-stock/v1/trading/order`;
    
    // 해외주식 주문 TR ID
    const trId = order.orderType === 'BUY'
      ? (this.config.isDemo ? 'VTTT1002U' : 'TTTT1002U')
      : (this.config.isDemo ? 'VTTT1001U' : 'TTTT1001U');

    // 해외주식 주문 데이터
    const orderData = {
      CANO: this.config.accountNo.substring(0, 8),
      ACNT_PRDT_CD: this.config.accountNo.substring(8) || '01',
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

  /**
   * 해외주식 잔고 조회
   */
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
    
    const params = new URLSearchParams({
      CANO: this.config.accountNo.substring(0, 8),
      ACNT_PRDT_CD: this.config.accountNo.substring(8) || '01',
      OVRS_EXCG_CD: 'NAS', // 미국 전체 (NAS+NYSE+AMEX)
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

    const output1 = result.output1 || {};
    const output2 = result.output2 || [];

    // 거래소명 매핑
    const exchangeNames: Record<string, string> = {
      'NAS': '나스닥',
      'NYS': '뉴욕',
      'AMS': '아멕스',
      'TKS': '도쿄',
      'HKS': '홍콩',
      'SHS': '상해',
      'SZS': '심천',
    };

    const positions: OverseasBalanceItem[] = output2.map((item: Record<string, string>) => ({
      stockCode: item.ovrs_pdno || '',
      stockName: item.ovrs_item_name || '',
      exchangeCode: item.ovrs_excg_cd || '',
      exchangeName: exchangeNames[item.ovrs_excg_cd] || item.ovrs_excg_cd,
      quantity: parseInt(item.ovrs_cblc_qty) || 0,
      avgPrice: parseFloat(item.pchs_avg_pric) || 0,
      currentPrice: parseFloat(item.now_pric2) || 0,
      profitLoss: parseInt(item.evlu_pfls_amt) || 0,
      profitRate: parseFloat(item.evlu_pfls_rt) || 0,
      evaluationAmount: parseInt(item.evlu_amt) || 0,
      foreignEvaluation: parseFloat(item.frcr_evlu_amt) || 0,
      exchangeRate: parseFloat(item.bass_exrt) || 1,
      currency: item.tr_crcy_cd || 'USD',
      purchaseAmount: parseFloat(item.frcr_pchs_amt1) || 0,
    }));

    return {
      totalDeposit: parseInt(output1.dnca_tot_amt) || parseInt(output1.wtch_amt) || 0,
      totalEvaluation: parseInt(output1.tot_evlu_amt) || 0,
      totalProfitLoss: parseInt(output1.tot_pfls) || 0,
      totalProfitRate: parseFloat(output1.tot_pfls_rt) || 0,
      availableAmount: parseInt(output1.prvs_rcdl_excc_amt) || parseInt(output1.wtch_amt) || 0,
      positions,
    };
  }

  /**
   * 해외주식 주문 취소
   */
  async cancelOverseasOrder(
    orderNo: string, 
    exchangeCode: string = 'NAS'
  ): Promise<OrderResponse> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/uapi/overseas-stock/v1/trading/order`;
    
    const trId = this.config.isDemo ? 'VTTT1004U' : 'TTTT1004U';

    const cancelData = {
      CANO: this.config.accountNo.substring(0, 8),
      ACNT_PRDT_CD: this.config.accountNo.substring(8) || '01',
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

  /**
   * 해외주식 종목 검색 (조건검색)
   * KIS API의 해외주식 상품기본정보 조회
   */
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

    // 단일 결과인 경우
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

  // ========================================
  // 모의 데이터 생성 (테스트용)
  // ========================================

  /**
   * 모의 데이터용 가격 생성 (국내, API 연결 없이 테스트)
   */
  static generateMockPrice(stockCode: string, stockName: string): StockPrice {
    const basePrice = 50000 + Math.floor(Math.random() * 100000);
    const changeRate = (Math.random() - 0.5) * 10;
    const changePrice = Math.floor(basePrice * changeRate / 100);
    
    return {
      stockCode,
      stockName,
      currentPrice: basePrice,
      previousClose: basePrice - changePrice,
      changePrice,
      changeRate: parseFloat(changeRate.toFixed(2)),
      highPrice: basePrice + Math.floor(Math.random() * 2000),
      lowPrice: basePrice - Math.floor(Math.random() * 2000),
      openPrice: basePrice - Math.floor(Math.random() * 1000),
      volume: Math.floor(Math.random() * 10000000),
      tradingValue: Math.floor(Math.random() * 1000000000000),
      market: 'DOMESTIC',
      currency: 'KRW',
    };
  }

  /**
   * 모의 해외주식 가격 생성 (테스트용)
   */
  static generateMockOverseasPrice(stockCode: string, stockName: string, exchangeCode: string = 'NAS'): OverseasStockPrice {
    const basePrice = 50 + Math.random() * 450; // $50 ~ $500
    const changeRate = (Math.random() - 0.5) * 8;
    const changePrice = basePrice * changeRate / 100;
    
    const exchangeNames: Record<string, string> = {
      'NAS': '나스닥',
      'NYS': '뉴욕',
      'AMS': '아멕스',
    };

    return {
      stockCode,
      stockName,
      exchangeCode,
      exchangeName: exchangeNames[exchangeCode] || exchangeCode,
      currentPrice: parseFloat(basePrice.toFixed(2)),
      previousClose: parseFloat((basePrice - changePrice).toFixed(2)),
      changePrice: parseFloat(changePrice.toFixed(2)),
      changeRate: parseFloat(changeRate.toFixed(2)),
      highPrice: parseFloat((basePrice * (1 + Math.random() * 0.03)).toFixed(2)),
      lowPrice: parseFloat((basePrice * (1 - Math.random() * 0.03)).toFixed(2)),
      openPrice: parseFloat((basePrice * (1 + (Math.random() - 0.5) * 0.02)).toFixed(2)),
      volume: Math.floor(1000000 + Math.random() * 50000000),
      currency: 'USD',
      marketPrice: parseFloat((basePrice * 0.99).toFixed(2)),
      afterHoursPrice: parseFloat((basePrice * 1.01).toFixed(2)),
    };
  }

  /**
   * 모의 캔들 데이터 생성 (국내)
   */
  static generateMockCandles(days: number = 120): StockCandle[] {
    const candles: StockCandle[] = [];
    let price = 50000 + Math.random() * 50000;
    const now = new Date();

    for (let i = days; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      
      const change = (Math.random() - 0.48) * price * 0.03;
      price = Math.max(1000, price + change);
      
      const high = price * (1 + Math.random() * 0.02);
      const low = price * (1 - Math.random() * 0.02);
      const open = low + Math.random() * (high - low);
      
      candles.push({
        date: date.toISOString().split('T')[0].replace(/-/g, ''),
        open: Math.floor(open),
        high: Math.floor(high),
        low: Math.floor(low),
        close: Math.floor(price),
        volume: Math.floor(1000000 + Math.random() * 10000000),
      });
    }

    return candles;
  }

  /**
   * 모의 해외주식 캔들 데이터 생성 (테스트용)
   */
  static generateMockOverseasCandles(days: number = 120): OverseasStockCandle[] {
    const candles: OverseasStockCandle[] = [];
    let price = 100 + Math.random() * 300;
    const now = new Date();

    for (let i = days; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      
      const change = (Math.random() - 0.48) * price * 0.03;
      price = Math.max(1, price + change);
      
      const high = price * (1 + Math.random() * 0.02);
      const low = price * (1 - Math.random() * 0.02);
      const open = low + Math.random() * (high - low);
      
      candles.push({
        date: date.toISOString().split('T')[0].replace(/-/g, ''),
        open: parseFloat(open.toFixed(2)),
        high: parseFloat(high.toFixed(2)),
        low: parseFloat(low.toFixed(2)),
        close: parseFloat(price.toFixed(2)),
        volume: Math.floor(500000 + Math.random() * 30000000),
        exchangeRate: 1320 + (Math.random() - 0.5) * 20,
      });
    }

    return candles;
  }

  /**
   * 모의 해외주식 잔고 생성 (테스트용)
   */
  static generateMockOverseasBalance(): {
    totalDeposit: number;
    totalEvaluation: number;
    totalProfitLoss: number;
    totalProfitRate: number;
    availableAmount: number;
    positions: OverseasBalanceItem[];
  } {
    const mockStocks = [
      { code: 'AAPL', name: '애플', exchange: 'NAS', avgPrice: 178.50, qty: 10 },
      { code: 'MSFT', name: '마이크로소프트', exchange: 'NAS', avgPrice: 378.20, qty: 5 },
      { code: 'GOOGL', name: '알파벳', exchange: 'NAS', avgPrice: 141.30, qty: 15 },
      { code: 'NVDA', name: '엔비디아', exchange: 'NAS', avgPrice: 480.00, qty: 8 },
      { code: 'TSLA', name: '테슬라', exchange: 'NAS', avgPrice: 245.60, qty: 12 },
      { code: 'AMZN', name: '아마존', exchange: 'NAS', avgPrice: 178.90, qty: 7 },
    ];

    const exchangeRate = 1330;
    
    const positions: OverseasBalanceItem[] = mockStocks.map(stock => {
      const currentPrice = stock.avgPrice * (1 + (Math.random() - 0.4) * 0.15);
      const profitRate = ((currentPrice - stock.avgPrice) / stock.avgPrice) * 100;
      const foreignEvaluation = currentPrice * stock.qty;
      const evaluationAmount = Math.floor(foreignEvaluation * exchangeRate);
      const purchaseAmount = stock.avgPrice * stock.qty;
      const profitLoss = Math.floor((currentPrice - stock.avgPrice) * stock.qty * exchangeRate);
      
      const exchangeNames: Record<string, string> = {
        'NAS': '나스닥',
        'NYS': '뉴욕',
        'AMS': '아멕스',
      };

      return {
        stockCode: stock.code,
        stockName: stock.name,
        exchangeCode: stock.exchange,
        exchangeName: exchangeNames[stock.exchange] || stock.exchange,
        quantity: stock.qty,
        avgPrice: parseFloat(stock.avgPrice.toFixed(2)),
        currentPrice: parseFloat(currentPrice.toFixed(2)),
        profitLoss,
        profitRate: parseFloat(profitRate.toFixed(2)),
        evaluationAmount,
        foreignEvaluation: parseFloat(foreignEvaluation.toFixed(2)),
        exchangeRate,
        currency: 'USD',
        purchaseAmount: parseFloat(purchaseAmount.toFixed(2)),
      };
    });

    const totalEvaluation = positions.reduce((sum, p) => sum + p.evaluationAmount, 0);
    const totalProfitLoss = positions.reduce((sum, p) => sum + p.profitLoss, 0);
    const totalPurchase = positions.reduce((sum, p) => sum + Math.floor(p.purchaseAmount * exchangeRate), 0);
    const totalProfitRate = totalPurchase > 0 ? (totalProfitLoss / totalPurchase) * 100 : 0;

    return {
      totalDeposit: 30000000,
      totalEvaluation,
      totalProfitLoss,
      totalProfitRate: parseFloat(totalProfitRate.toFixed(2)),
      availableAmount: 15000000,
      positions,
    };
  }
}
