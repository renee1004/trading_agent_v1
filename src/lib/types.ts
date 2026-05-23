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
  // 검증 로그 필드 (optional)
  originalStockCode?: string;
  normalizedSymbol?: string;
  currentPriceField?: string;
  rawPriceFields?: {
    last: unknown;
    base: unknown;
    high: unknown;
    low: unknown;
  };
  source?: string;
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
  orderKind: '00' | '01' | '02' | '61' | '62' | '81'; // 00:지정가, 01:시장가, 02:조건부지정가, 61:장전시간외종가, 62:시간외단일가, 81:장후시간외종가
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
  // 해외주식 가격 검증 필드 (주문 전 분석가 vs 현재가 괴리율 체크)
  analysisPrice?: number;       // 마지막 일봉 종가 (분석 기준가)
  currentPrice?: number;        // 주문 직전 현재가 (KIS REST 실시간)
  priceGapPercent?: number;     // |currentPrice - analysisPrice| / analysisPrice
  currentPriceTimestamp?: string; // 현재가 조회 시각
  dataSource?: string;          // "daily_candle+current_price" 등
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

// 시장별 전략 기본 파라미터 (국내 vs 해외 차별화)
export interface MarketStrategyDefaults {
  // === 복합 지표 전략 (COMPOSITE) ===
  composite: {
    atrPeriod: number;
    atrMultiplier: number;
    rsiPeriod: number;
    rsiOverbought: number;    // 국내: 70, 해외: 75 (더 높은 변동성 수용)
    rsiOversold: number;      // 국내: 30, 해외: 25 (더 깊은 과매도 대기)
    macdFast: number;
    macdSlow: number;
    macdSignal: number;
    bbPeriod: number;
    bbStdDev: number;         // 국내: 2.0, 해외: 2.5 (변동성 더 큼)
    maShort: number;
    maLong: number;
  };
  // === 변동성 돌파 전략 (VOLATILITY_BREAKOUT) ===
  volatilityBreakout: {
    volatilityK: number;      // 국내: 0.5, 해외: 0.4 (미국은 더 보수적)
    stopLoss: number;         // 국내: 3%, 해외: 5% (상하한가 없음)
    takeProfit: number;       // 국내: 10%, 해외: 15%
    minVolumeRatio: number;   // 최소 거래량 비율 (해외는 거래량 큼)
  };
  // === SuperTrend 전략 ===
  superTrend: {
    atrPeriod: number;        // 국내: 10, 해외: 14 (더 긴 주기 안정성)
    atrMultiplier: number;    // 국내: 3.0, 해외: 4.0 (변동성 더 큼)
    rsiPeriod: number;
    macdFast: number;
    macdSlow: number;
    macdSignal: number;
  };
  // === 평균 회귀 전략 (MEAN_REVERSION) ===
  meanReversion: {
    bbPeriod: number;
    bbStdDev: number;         // 국내: 2.0, 해외: 2.5
    rsiPeriod: number;
    rsiOverbought: number;    // 국내: 70, 해외: 80 (미국은 추세 지속력 강함)
    rsiOversold: number;      // 국내: 30, 해외: 20
  };
  // === 모멘텀 전략 (MOMENTUM) ===
  momentum: {
    rsiPeriod: number;
    maShort: number;
    maLong: number;
    volumeSpikeThreshold: number; // 국내: 2.0배, 해외: 1.5배 (미국은 기본 거래량 큼)
    minConsecutiveDays: number;   // 연속 상승일 최소 조건
  };
  // === 전략 가중치 ===
  strategyWeights: {
    COMPOSITE: number;
    SUPER_TREND: number;
    VOLATILITY_BREAKOUT: number;
    MEAN_REVERSION: number;
    MOMENTUM: number;
  };
}

// 시장별 리스크 기본 설정
export interface MarketRiskDefaults {
  maxPositionSize: number;    // 국내: 10%, 해외: 7% (환율리스크 추가)
  maxDailyLoss: number;       // 국내: 3%, 해외: 4% (변동성 더 큼)
  maxTotalLoss: number;       // 국내: 10%, 해외: 12%
  maxOpenPositions: number;   // 국내: 5, 해외: 4 (집중 관리)
  stopLossPercent: number;    // 국내: 5%, 해외: 7% (상하한가 없음)
  takeProfitPercent: number;  // 국내: 15%, 해외: 20% (더 큰 움직임)
  trailingStopPercent: number;// 국내: 3%, 해외: 5%
  exchangeRateBuffer: number; // 해외만: 환율 변동 버퍼 (1~2%)
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
