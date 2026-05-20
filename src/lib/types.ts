// 한국투자증권 KIS Open API 타입 정의

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
}

export interface AccountBalance {
  totalDeposit: number;
  totalEvaluation: number;
  totalProfitLoss: number;
  totalProfitRate: number;
  availableAmount: number;
  positions: BalanceItem[];
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
}
