// 한국투자증권 KIS Open API 클라이언트
// REST API + WebSocket 실시간 시세 지원

import { 
  KisConfig, 
  StockPrice, 
  StockCandle, 
  OrderRequest, 
  OrderResponse, 
  AccountBalance, 
  BalanceItem 
} from './types';

const DEMO_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
const REAL_BASE_URL = 'https://openapi.koreainvestment.com:9443';

export class KisApiClient {
  private config: KisConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(config: KisConfig) {
    this.config = config;
    if (config.accessToken && config.tokenExpiresAt) {
      this.accessToken = config.accessToken;
      this.tokenExpiresAt = config.tokenExpiresAt;
    }
  }

  private get baseUrl(): string {
    return this.config.isDemo ? DEMO_BASE_URL : REAL_BASE_URL;
  }

  /**
   * 접근 토큰 발급 (24시간 유효)
   */
  async issueToken(): Promise<string> {
    const url = `${this.baseUrl}/oauth2/tokenP`;
    
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      appkey: this.config.appKey,
      appsecret: this.config.appSecret,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`KIS 토큰 발급 실패: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (data.error_code) {
      throw new Error(`KIS 토큰 에러: ${data.error_code} - ${data.error_description}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = new Date(Date.now() + (data.expires_in || 86400) * 1000);
    
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

  /**
   * 주식 현재가 조회
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
    };
  }

  /**
   * 주식 일봉 데이터 조회
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
   * 주식 매수/매도 주문
   */
  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
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
   * 계좌 잔고 조회
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
   * 주문 취소
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

  /**
   * 모의 데이터용 가격 생성 (API 연결 없이 테스트)
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
    };
  }

  /**
   * 모의 캔들 데이터 생성
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
}
