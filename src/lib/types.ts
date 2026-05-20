// 한국투자증권 KIS Open API 타입 정의

// 시장 구분 타입
export type MarketType = 'DOMESTIC' | 'OVERSEAS';
export type OverseasExchange = 'NAS' | 'NYS' | 'AMS' | 'TKS' | 'HKS' | 'SHS' | 'SZS' | 'HKI' | 'BSE' | 'SSE';

export interface KisConfig {
  appKey: string;
  appSecret: string;
  accountNo: string;
  isDemo: boolean;
  accessToken?: string;
  tokenExpiresAt?: Date;
}

export interface KisTokenResponse {
  access_token: string;
  access_token_token_expired: string;
  token_type: string;
  expires_in: number;
}

export interface StockPrice {
  stockCode: string;
  stockName: string;
  currentPrice: number;
  previousClose: number;
  changePrice: number;
  changeRate: number;
  highPrice: number;
  lowPrice: number;
  openPrice: number;
  volume: number;
  tradingValue: number;
  market?: MarketType;
  currency?: string; // KRW, USD 등
}

// 해외주식 현재가
export interface OverseasStockPrice {
  stockCode: string;       // 종목코드 (예: AAPL)
  stockName: string;      // 종목명
  exchangeCode: string;   // 거래소코드 (NAS, NYS, AMS)
  exchangeName: string;   // 거래소명
  currentPrice: number;   // 현재가 (현지통화)
  previousClose: number;  // 전일종가
  changePrice: number;    // 전일대비
  changeRate: number;     // 등락율
  highPrice: number;      // 고가
  lowPrice: number;       // 저가
  openPrice: number;      // 시가
  volume: number;         // 거래량
  currency: string;       // 통화 (USD)
  marketPrice: number;    // 장전시가
  afterHoursPrice: number;// 시간외가격
}

// 해외주식 일봉
export interface OverseasStockCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  exchangeRate?: number; // 환율
}

export interface StockCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderRequest {
  stockCode: string;
  orderType: 'BUY' | 'SELL';
  quantity: number;
  price?: number; // 지정가일 경우
  orderKind: '00' | '01' | '02'; // 00:지정가, 01:시장가, 02:조건부지정가
  market?: MarketType;
  exchangeCode?: string; // 해외주식 거래소 코드 (NAS, NYS, AMS)
}

export interface OrderResponse {
  orderNo: string;
  status: string;
  message: string;
}

export interface BalanceItem {
  stockCode: string;
  stockName: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  profitLoss: number;
  profitRate: number;
  evaluationAmount: number;
  market?: MarketType;
  currency?: string;
  exchangeCode?: string;  // 해외 거래소 코드
  exchangeRate?: number;  // 환율
  foreignAmount?: number; // 외화 평가금액
}

// 해외주식 잔고 아이템
export interface OverseasBalanceItem {
  stockCode: string;
  stockName: string;
  exchangeCode: string;    // 거래소코드
  exchangeName: string;    // 거래소명
  quantity: number;         // 보유수량
  avgPrice: number;         // 평균단가 (외화)
  currentPrice: number;     // 현재가 (외화)
  profitLoss: number;       // 평가손익 (원화)
  profitRate: number;       // 수익률
  evaluationAmount: number; // 평가금액 (원화)
  foreignEvaluation: number;// 외화평가금액
  exchangeRate: number;     // 환율
  currency: string;         // 통화
  purchaseAmount: number;   // 매입금액 (외화)
}

export interface AccountBalance {
  totalDeposit: number;
  totalEvaluation: number;
  totalProfitLoss: number;
  totalProfitRate: number;
  availableAmount: number;
  positions: BalanceItem[];
  overseasPositions?: OverseasBalanceItem[];
  overseasTotalDeposit?: number;
  overseasTotalEvaluation?: number;
  overseasTotalProfitLoss?: number;
  overseasTotalProfitRate?: number;
  overseasAvailableAmount?: number;
}

export interface TradingSignal {
  stockCode: string;
  stockName: string;
  signalType: 'BUY' | 'SELL' | 'HOLD';
  strategy: string;
  confidence: number; // 0-100
  price: number;
  reason: string;
  indicators: Record<string, number>;
  timestamp: Date;
}

export interface StrategyConfig {
  id?: string;
  name: string;
  type: StrategyType;
  parameters: StrategyParameters;
  isActive: boolean;
}

export type StrategyType = 
  | 'COMPOSITE' 
  | 'VOLATILITY_BREAKOUT' 
  | 'SUPER_TREND' 
  | 'MEAN_REVERSION'
  | 'MOMENTUM';

export interface StrategyParameters {
  // 공통
  period?: number;
  
  // SuperTrend
  atrPeriod?: number;
  atrMultiplier?: number;
  
  // RSI
  rsiPeriod?: number;
  rsiOverbought?: number;
  rsiOversold?: number;
  
  // MACD
  macdFast?: number;
  macdSlow?: number;
  macdSignal?: number;
  
  // Bollinger Bands
  bbPeriod?: number;
  bbStdDev?: number;
  
  // Moving Average
  maShort?: number;
  maLong?: number;
  
  // 볼린저밴드 돌파
  bbBreakoutMultiplier?: number;
  
  // 변동성 돌파
  volatilityK?: number; // k값 (보통 0.5)
  
  // 리스크 관리
  stopLoss?: number;
  takeProfit?: number;
  trailingStop?: number;
}

export interface RiskConfig {
  maxPositionSize: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  maxOpenPositions: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
}

export interface BacktestResult {
  strategy: string;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  totalProfit: number;
  totalProfitRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
  trades: BacktestTrade[];
}

export interface BacktestTrade {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  profitLoss: number;
  profitRate: number;
  signal: string;
}

export interface DashboardData {
  accountBalance: AccountBalance;
  positions: BalanceItem[];
  recentTrades: TradeLogItem[];
  activeStrategy: string;
  tradingStatus: 'RUNNING' | 'STOPPED' | 'PAUSED';
  todayProfit: number;
  todayProfitRate: number;
  signals: TradingSignal[];
}

export interface TradeLogItem {
  id: string;
  stockCode: string;
  stockName: string;
  tradeType: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  totalAmount: number;
  strategy: string;
  profitLoss?: number;
  profitRate?: number;
  status: string;
  signalReason?: string;
  tradedAt: Date;
  market?: MarketType;
  currency?: string;
  exchangeCode?: string;
}

// 해외주식 검색 결과
export interface OverseasSearchResult {
  code: string;           // 종목코드 (티커)
  name: string;           // 종목명
  nameEng: string;        // 영문종목명
  exchangeCode: string;   // 거래소코드
  exchangeName: string;   // 거래소명
  sector: string;         // 섹터
  currency: string;       // 통화
  market: string;         // 시장구분
}
