// 자동매매 에이전트 코어
// 시그널 생성 → 리스크 체크 → 주문 실행 → 포지션 모니토링 전체 파이프라인
// 국내주식 + 해외주식 지원

import { db } from './db';
import { KisApiClient, normalizeOverseasSymbol } from './kis-api';
import { TradingEngine } from './trading-engine';
import { RiskManager } from './risk-manager';
import { scanTargetStocks } from './market-scanner';
import { aiAnalyzer } from './ai-analyzer';
import { normalizeStockCode, isKoreanSymbol } from './stock-master';
import { 
  KisConfig, StockCandle, OverseasStockCandle, 
  BalanceItem, OverseasBalanceItem, MarketType,
  OrderRequest, TradingSignal
} from './types';
import { getDomesticSession, getKSTNow, DomesticSession } from './agent-scheduler';
import { getOrCreateKisConfigFromEnv } from './kis-config-loader';
import {
  getEffectiveTradingSettings,
  buildRiskConfigFromSettings,
  formatSettingsSummary,
  computeRuntimeDecision,
  validateOrderExecution,
  EffectiveTradingSettings,
  RuntimeDecision,
} from './effective-settings';
import { checkPriceAnomaly, applyPriceAnomalyToSignal, PRICE_ANOMALY_THRESHOLD } from './price-anomaly';

// 에이전트 로그 타입
export interface AgentLog {
  id: string;
  timestamp: Date;
  type: 'INFO' | 'SIGNAL' | 'TRADE' | 'RISK' | 'ERROR' | 'EXIT';
  market: MarketType;
  message: string;
  details?: Record<string, unknown>;
}

// 에이전트 실행 결과
export interface AgentCycleResult {
  success: boolean;
  startTime: Date;
  endTime: Date;
  stocksAnalyzed: number;
  signalsGenerated: number;
  ordersPlaced: number;
  positionsMonitored: number;
  exitsExecuted: number;
  logs: AgentLog[];
  errors: string[];
  // 분석 성공/실패 종목 수
  domesticSuccess: number;
  domesticFailed: number;
  overseasSuccess: number;
  overseasFailed: number;
  // stocksAnalyzed가 0일 때 원인
  zeroAnalysisReason?: string;
  // ── 진단 필드 (status API에서 사용) ──
  uiSignalsCount?: number;
  executableSignalsCount?: number;
  signalsBlockedReasons?: string[];
  topBuyCandidates?: Array<{stockCode: string; stockName: string; confidence: number; signalType: string; buyScore?: number; sellScore?: number; finalThreshold?: number; blockedReason?: string; holdReason?: string}>;
  signalThreshold?: number;
  weakSignalThreshold?: number;
  minConfidenceThreshold?: number;
  strategyAggressiveness?: string;
  positionQueryFailed?: boolean;
  positionQueryFailedReason?: string;
  forceTestSignalUsed?: boolean;
}

// 에이전트 상태
export interface AgentStatus {
  isRunning: boolean;
  currentSessionId: string | null;
  lastCycleTime: Date | null;
  lastCycleResult: AgentCycleResult | null;
  totalCycles: number;
  totalTrades: number;
  dailyPnL: number;
  logs: AgentLog[];
  // ── 주문 카운트 분리 ──
  ordersAttempted: number;   // 주문 시도 (BLOCKED 포함)
  ordersSubmitted: number;   // KIS에 제출됨 (PENDING)
  ordersFilled: number;     // 체결 완료 (FILLED)
  ordersBlocked: number;    // 사전검증 차단
  ordersFailed: number;     // KIS API 실패
  // ── 거래내역 저장 실패 추적 ──
  tradeHistorySaveFailures: Array<{time: Date; market: string; stockCode: string; error: string}>;
}

// 메모리 내 에이전트 상태 (서버 재시작 시 리셋)
let agentState: AgentStatus = {
  isRunning: false,
  currentSessionId: null,
  lastCycleTime: null,
  lastCycleResult: null,
  totalCycles: 0,
  totalTrades: 0,
  dailyPnL: 0,
  logs: [],
  ordersAttempted: 0,
  ordersSubmitted: 0,
  ordersFilled: 0,
  ordersBlocked: 0,
  ordersFailed: 0,
  tradeHistorySaveFailures: [],
};

const MAX_LOGS = 200;

// =============================================
// BUY 후보 엄격 사전 필터 (9가지 조건)
// =============================================
// CONSERVATIVE 모드에서 signalThreshold/weakSignalThreshold 이상의
// buyScore를 가진 신호도 추가 조건으로 엄격하게 필터링
// → executableSignals에 포함되려면 모든 조건 통과 필요
interface BuyFilterResult {
  pass: boolean;
  reason: string;
}

function filterBuyCandidateStrict(
  signal: TradingSignal,
  candles: StockCandle[],
  domesticPositions: BalanceItem[],
  maxOpenDomesticPositions: number,
): BuyFilterResult {
  const ind = signal.indicators || {};
  const currentPrice = signal.currentPrice || signal.price;

  // 1. priceAnomaly=false (이미 상위에서 차단되지만 안전장치)
  if (signal.priceAnomaly) {
    return { pass: false, reason: '가격 anomaly' };
  }

  // 2. currentPrice > MA20
  const ma20 = ind.maLong;
  if (ma20 && currentPrice > 0 && currentPrice <= ma20) {
    return { pass: false, reason: `currentPrice(${currentPrice.toLocaleString()}) ≤ MA20(${ma20.toLocaleString()})` };
  }

  // 3. MA5 > MA20 (단기 추세 상승 확인)
  const ma5 = ind.maShort;
  if (ma5 && ma20 && ma5 <= ma20) {
    return { pass: false, reason: `MA5(${ma5.toLocaleString()}) ≤ MA20(${ma20.toLocaleString()}) — 추세 하락` };
  }

  // 4. RSI 45~65 (중립 구간 — 과매수/과매도 모두 배제)
  const rsi = ind.rsi;
  if (rsi !== undefined && rsi !== null && !isNaN(rsi)) {
    if (rsi < 45 || rsi > 65) {
      return { pass: false, reason: `RSI(${rsi.toFixed(1)}) 외 구간 (45~65 요구)` };
    }
  }

  // 5. sellScore < 25 (매도 압력이 낮아야 매수)
  if (signal.sellScore !== undefined && signal.sellScore !== null && signal.sellScore >= 25) {
    return { pass: false, reason: `sellScore(${signal.sellScore}) ≥ 25 — 매도 압력 높음` };
  }

  // 6. 최근 3봉 중 2봉 이상 양봉 (단기 모멘텀 확인)
  if (candles.length >= 3) {
    const recent3 = candles.slice(-3);
    const bullishCount = recent3.filter(c => c.close > c.open).length;
    if (bullishCount < 2) {
      return { pass: false, reason: `최근 3봉 중 양봉 ${bullishCount}개 < 2개` };
    }
  }

  // 7. 거래량 증가 (최근 봉 거래량 ≥ 직전 봉)
  if (candles.length >= 2) {
    const lastVol = candles[candles.length - 1].volume;
    const prevVol = candles[candles.length - 2].volume;
    if (prevVol > 0 && lastVol < prevVol) {
      return { pass: false, reason: `거래량 감소 (최근=${lastVol.toLocaleString()} < 직전=${prevVol.toLocaleString()})` };
    }
  }

  // 8. 이미 보유 중이면 추가매수 금지
  const alreadyHeld = domesticPositions.find(p => p.stockCode === signal.stockCode);
  if (alreadyHeld) {
    return { pass: false, reason: '이미 보유 중 — 추가매수 금지' };
  }

  // 9. currentOpenDomesticPositions < maxOpenDomesticPositions
  if (domesticPositions.length >= maxOpenDomesticPositions) {
    return { pass: false, reason: `국내 포지션 한도 초과 (${domesticPositions.length}/${maxOpenDomesticPositions})` };
  }

  return { pass: true, reason: '' };
}

export function addLog(
  type: AgentLog['type'],
  market: MarketType,
  message: string,
  details?: Record<string, unknown>
): AgentLog {
  const log: AgentLog = {
    id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date(),
    type,
    market,
    message,
    details,
  };
  agentState.logs = [log, ...agentState.logs].slice(0, MAX_LOGS);

  // DB에 로그 영속화 (비동기, 실패해도 무시)
  db.agentLog.create({
    data: {
      type,
      market,
      message,
      details: details ? JSON.stringify(details) : null,
      sessionId: agentState.currentSessionId,
    },
  }).catch(() => {});

  return log;
}

/**
 * KIS 설정 로드
 * 공통 모듈(kis-config-loader)을 사용하여 DB + 환경변수 fallback 로드
 * - 1순위: DB에 저장된 설정
 * - 2순위: 환경변수 (KIS_APP_KEY/KIS_APPKEY/APP_KEY 등 fallback 우선순위 적용)
 * - 환경변수에서 로드 시 DB에 자동 저장
 * - 계좌번호 8자리 → 10자리 자동 정규화
 * - App Secret 전체값 로그 미출력, App Key는 앞 4자리만 표시
 */
async function loadKisConfig(): Promise<KisConfig | null> {
  const config = await getOrCreateKisConfigFromEnv();

  if (config) {
    // 에이전트 로그에 기록 (민감정보 마스킹)
    const maskedKey = config.appKey.substring(0, 4) + '****';
    const maskedAccount = config.accountNo.replace(/-/g, '').length > 4
      ? config.accountNo.replace(/-/g, '').substring(0, 2) + '****' + config.accountNo.replace(/-/g, '').slice(-2)
      : '****';
    addLog('INFO', 'DOMESTIC', `KIS 설정 로드 완료 (appKey=${maskedKey}, accountNo=${maskedAccount}, isDemo=${config.isDemo})`);
  } else {
    addLog('INFO', 'DOMESTIC', 'KIS 설정 없음 - 실제 매매 불가 (신호 분석만 수행). 필요 환경변수: KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NO 또는 KIS_ACCOUNT');
  }

  return config;
}

/**
 * 분석 대상 종목 로드
 * 보유종목 + 관심종목 + 우량 대형주 풀 병합 (market-scanner 사용)
 * 중복 자동 제거, 보유종목 우선
 *
 * TEST 모드(PIPELINE_TEST, STRATEGY_TEST)에서는:
 * - 저가 ETF 후보군 자동 포함 (고가주 차단 문제 해결)
 * - maxDomesticOrderAmount 기반 고가주 자동 제외
 */
async function loadTargetStocks(
  kisClient: KisApiClient | null,
  settings?: EffectiveTradingSettings
): Promise<{
  domestic: Array<{ code: string; name: string }>;
  overseas: Array<{ code: string; name: string; exchange: string }>;
}> {
  // TEST 모드 판단
  const isTestMode = settings?.strategyAggressiveness === 'PIPELINE_TEST'
    || settings?.strategyAggressiveness === 'STRATEGY_TEST';

  // 고가주 필터링은 TEST 모드 + PAPER 모드에서만 수행
  // (DRY_RUN은 분석만 하므로 모든 종목 포함, LIVE는 별도 안전장치)
  const shouldFilterHighPrice = isTestMode
    && settings?.orderExecutionMode === 'PAPER'
    && (settings?.maxDomesticOrderAmount ?? 0) > 0;

  // 현재가 조회 함수 (KIS 클라이언트가 있을 때만)
  const getStockPrice = kisClient
    ? async (code: string): Promise<number | null> => {
        try {
          const stockPrice = await kisClient.getStockPrice(code);
          return stockPrice.currentPrice || null;
        } catch {
          return null;
        }
      }
    : undefined;

  const result = await scanTargetStocks(kisClient, {
    includeEtfs: true,  // 항상 ETF 후보 포함
    maxDomesticOrderAmount: shouldFilterHighPrice ? settings!.maxDomesticOrderAmount : 0,
    getStockPrice,
  });

  // 고가주 차단 로깅 (사용자 진단용)
  if (result.highPriceSkipped && result.highPriceSkipped.length > 0) {
    addLog('INFO', 'DOMESTIC',
      `⚠️ ${result.highPriceSkipped.length}개 고가주 후보 제외 (1주 가격 > maxDomesticOrderAmount=${settings!.maxDomesticOrderAmount.toLocaleString()}원)`,
      {
        skipped: result.highPriceSkipped.map(s => ({ code: s.code, name: s.name, reason: s.reason })),
        hint: '저가 ETF 후보군이 자동으로 대체 포함됨',
      }
    );
  }

  return {
    domestic: result.domestic,
    overseas: result.overseas,
  };
}

/**
 * 캔들 데이터 조회 (실제 API만 사용, 모의 데이터 사용 안 함)
 * 실패 시 상세 에러 정보를 로그에 남김
 */
async function fetchCandles(
  kisClient: KisApiClient | null,
  stockCode: string,
  stockName: string,
  market: MarketType,
  exchangeCode?: string
): Promise<{ candles: StockCandle[]; error?: string }> {
  // KIS 클라이언트가 없으면 조회 불가
  if (!kisClient) {
    const reason = 'KIS 클라이언트 없음';
    addLog('ERROR', market, `${stockName}(${stockCode}) 캔들 조회 불가 - ${reason}`);
    return { candles: [], error: reason };
  }

  // ── KRX 코드 정규화 ──
  // stockCode에 'KRX:069500' 같은 접두사가 있으면 '069500'으로 변환
  // KIS API는 순수 6자리 종목코드만 허용
  const normalizedCode = normalizeStockCode(stockCode);
  if (normalizedCode !== stockCode) {
    addLog('INFO', market, `${stockName} 종목코드 정규화: ${stockCode} → ${normalizedCode}`, {
      originalCode: stockCode,
      normalizedCode,
      market,
    });
  }

  try {
    if (market === 'OVERSEAS' && exchangeCode) {
      const overseasCandles = await kisClient.getOverseasDailyCandles(
        normalizedCode, exchangeCode, '3M'
      );
      // OverseasStockCandle → StockCandle 변환
      const candles = overseasCandles.map(c => ({
        date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      return { candles };
    } else {
      const candles = await kisClient.getStockDailyCandles(normalizedCode, '3M');
      return { candles };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    addLog('ERROR', market, `${stockName}(${stockCode}) 캔들 데이터 조회 실패`, {
      originalCode: stockCode,
      normalizedCode,
      stockName,
      market,
      exchangeCode: exchangeCode || '',
      error: errorMsg,
    });
    return { candles: [], error: errorMsg };
  }
}

/**
 * 현재 포지션 조회
 */
async function fetchPositions(
  kisClient: KisApiClient | null,
  market: MarketType
): Promise<{
  positions: BalanceItem[];
  overseasPositions: OverseasBalanceItem[];
  accountBalance: number;
}> {
  if (!kisClient) {
    return { positions: [], overseasPositions: [], accountBalance: 0 };
  }

  try {
    if (market === 'DOMESTIC') {
      const balance = await kisClient.getAccountBalance();
      return {
        positions: balance.positions,
        overseasPositions: [],
        accountBalance: balance.availableAmount,
      };
    } else {
      const balance = await kisClient.getOverseasAccountBalance();
      // OverseasBalanceItem → BalanceItem 변환 (리스크 매니저용)
      const convertedPositions: BalanceItem[] = balance.positions.map(p => ({
        stockCode: p.stockCode,
        stockName: p.stockName,
        quantity: p.quantity,
        avgPrice: p.avgPrice,
        currentPrice: p.currentPrice,
        profitLoss: p.profitLoss,
        profitRate: p.profitRate,
        evaluationAmount: p.evaluationAmount,
        market: 'OVERSEAS',
        currency: 'USD',
        exchangeCode: p.exchangeCode,
        exchangeRate: p.exchangeRate,
      }));
      return {
        positions: convertedPositions,
        overseasPositions: balance.positions,
        accountBalance: balance.availableAmount,
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // KIS API 에러 상세 정보 추출 (rt_cd, msg_cd, msg1 포함 여부 확인)
    const errorDetails: Record<string, unknown> = {
      error: errorMsg,
      market,
    };
    // 에러 메시지에서 KIS 상태코드 파싱 시도
    const rtCdMatch = errorMsg.match(/rt_cd=([^,\)]+)/);
    const msgCdMatch = errorMsg.match(/msg_cd=([^,\)]+)/);
    const msg1Match = errorMsg.match(/msg1=([^,\)]+)/);
    if (rtCdMatch) errorDetails.rt_cd = rtCdMatch[1];
    if (msgCdMatch) errorDetails.msg_cd = msgCdMatch[1];
    if (msg1Match) errorDetails.msg1 = msg1Match[1];

    addLog('ERROR', market, `${market === 'DOMESTIC' ? '국내' : '해외'} 포지션 조회 실패`, errorDetails);
    return { positions: [], overseasPositions: [], accountBalance: 0 };
  }
}

/**
 * 국내 주문 정책 체크
 * 현재 거래세션과 시그널 타입에 따라 주문 허용 여부 결정
 *
 * 규칙:
 * - BUY: 정규장 09:00~15:10만 허용
 * - SELL/RISK_EXIT: 정규장 09:00~15:20만 허용
 * - 시간외: settings.allowAfterHoursTrading이 true일 때만 허용
 *   (DB 저장 설정 > 환경변수 > 기본값 false)
 */
function getDomesticOrderPolicy(
  signal: TradingSignal,
  allowAfterHoursTrading: boolean
): { allowed: boolean; reason: string; session: DomesticSession } {
  const sessionInfo = getDomesticSession();
  const { session } = sessionInfo;

  // 장외: 항상 차단
  if (session === 'CLOSED') {
    return { allowed: false, reason: `장외 시간 (${sessionInfo.label})`, session };
  }

  // 정규장: BUY/SELL 시간 제한
  if (session === 'REGULAR') {
    const { totalMinutes } = getKSTNow();

    if (signal.signalType === 'BUY') {
      // BUY: 09:00~15:10만 허용
      if (totalMinutes >= 540 && totalMinutes <= 910) {
        return { allowed: true, reason: `정규장 매수 허용`, session };
      }
      const curH = Math.floor(totalMinutes / 60);
      const curM = totalMinutes % 60;
      return { allowed: false, reason: `정규장 매수 마감 (15:10 이후, 현재 ${String(curH).padStart(2,'0')}:${String(curM).padStart(2,'0')})`, session };
    }

    // SELL (RISK_EXIT 포함): 09:00~15:20만 허용
    if (signal.signalType === 'SELL') {
      if (totalMinutes >= 540 && totalMinutes <= 920) {
        return { allowed: true, reason: `정규장 매도 허용`, session };
      }
      const curH = Math.floor(totalMinutes / 60);
      const curM = totalMinutes % 60;
      return { allowed: false, reason: `정규장 매도 마감 (15:20 이후, 현재 ${String(curH).padStart(2,'0')}:${String(curM).padStart(2,'0')})`, session };
    }
  }

  // 시간외 세션: 기본 차단, settings.allowAfterHoursTrading이 true인 경우만 허용
  const afterHoursSessions: DomesticSession[] = [
    'PREMARKET_CLOSE', 'OPENING_CALL_AUCTION', 'CLOSING_CALL_AUCTION',
    'POSTMARKET_CLOSE', 'AFTERHOURS_SINGLE',
  ];
  if (afterHoursSessions.includes(session)) {
    if (allowAfterHoursTrading) {
      return { allowed: true, reason: `시간외 거래 허용 (${sessionInfo.label}, allowAfterHoursTrading=true)`, session };
    }
    return { allowed: false, reason: `시간외 거래 차단 (${sessionInfo.label})`, session };
  }

  return { allowed: false, reason: `알 수 없는 세션 (${sessionInfo.label})`, session };
}

/**
 * 주문 실행 및 기록
 * - 리스크 매니저가 계산한 quantity를 실제 주문에 반영
 * - KIS API 주문 실패를 모의 체결로 바꾸지 않음
 * - 국내 주문은 getDomesticOrderPolicy()로 세션별 허용 여부 사전 체크
 * - PENDING: success true 반환, 포지션 DB는 업데이트하지 않음
 * - FILLED: success true 반환, 포지션 DB 업데이트
 */
async function executeOrder(
  kisClient: KisApiClient | null,
  signal: TradingSignal,
  market: MarketType,
  settings: EffectiveTradingSettings,
  exchangeCode?: string,
  quantity: number = 1
): Promise<{ success: boolean; orderNo: string; message: string }> {
  // ── 가격 anomaly 안전장치 (defense in depth) ──
  // signal.priceAnomaly=true면 절대 주문하지 않음
  // (DOMESTIC 분석 루프와 monitorPositions에서 이미 차단하지만,
  //  다른 호출 경로도 보호하기 위해 executeOrder入口에서 한 번 더 검증)
  if (signal.priceAnomaly) {
    addLog('RISK', market,
      `executeOrder 차단: ${signal.stockName} 가격 anomaly — ${signal.anomalyReason || '사유 없음'}`,
      {
        stockCode: signal.stockCode,
        signalType: signal.signalType,
        strategy: signal.strategy,
        price: signal.price,
        analysisPrice: signal.analysisPrice,
        currentPrice: signal.currentPrice,
        priceGapPercent: signal.priceGapPercent,
        anomalyReason: signal.anomalyReason,
        blockedBy: 'PRICE_ANOMALY_AT_EXECUTE_ORDER',
      }
    );
    return {
      success: false,
      orderNo: '',
      message: `가격 anomaly로 주문 차단: ${signal.anomalyReason || '괴리 20% 이상'}`,
    };
  }

  // ── ★ 런타임 안전 가드 (defense in depth) ──
  // ALLOW_STRATEGY_TEST_ORDER가 아니면 테스트 전략 주문 무조건 차단
  const ALLOW_STRATEGY_TEST_ORDER = process.env.ALLOW_STRATEGY_TEST_ORDER === 'true';
  if (!ALLOW_STRATEGY_TEST_ORDER) {
    if (settings.strategyAggressiveness !== 'CONSERVATIVE') {
      addLog('RISK', market,
        `executeOrder 차단: ${signal.stockName} 비보수 전략 (${settings.strategyAggressiveness}) — ALLOW_STRATEGY_TEST_ORDER=false`,
        { stockCode: signal.stockCode, blockedBy: 'SAFE_MODE_STRATEGY' }
      );
      return { success: false, orderNo: '', message: `안전 모드: ${settings.strategyAggressiveness} 전략 주문 차단` };
    }
    if (settings.killSwitchEnabled) {
      addLog('RISK', market,
        `executeOrder 차단: ${signal.stockName} killSwitchEnabled=true`,
        { stockCode: signal.stockCode, blockedBy: 'KILL_SWITCH' }
      );
      return { success: false, orderNo: '', message: '안전 모드: killSwitch가 활성화되어 주문 차단' };
    }
    if (!settings.autoDomesticOrderEnabled && market === 'DOMESTIC') {
      addLog('RISK', market,
        `executeOrder 차단: ${signal.stockName} autoDomesticOrderEnabled=false`,
        { stockCode: signal.stockCode, blockedBy: 'AUTO_ORDER_DISABLED' }
      );
      return { success: false, orderNo: '', message: '안전 모드: 자동 국내 주문 비활성화' };
    }
  }

  // 실전 위험 모드 차단 (ALLOW_STRATEGY_TEST_ORDER와 무관)
  if (settings.tradingMode !== 'DEMO' && !settings.allowRealDomesticOrder && market === 'DOMESTIC') {
    addLog('RISK', market,
      `executeOrder 차단: ${signal.stockName} DEMO가 아닌데 allowRealDomesticOrder=false`,
      { stockCode: signal.stockCode, blockedBy: 'REAL_ORDER_BLOCKED' }
    );
    return { success: false, orderNo: '', message: '안전 모드: 실전 주문 권한 없음' };
  }
  if (settings.orderExecutionMode === 'LIVE' && !settings.allowRealDomesticOrder && market === 'DOMESTIC') {
    addLog('RISK', market,
      `executeOrder 차단: ${signal.stockName} LIVE 모드인데 allowRealDomesticOrder=false`,
      { stockCode: signal.stockCode, blockedBy: 'LIVE_ORDER_BLOCKED' }
    );
    return { success: false, orderNo: '', message: '안전 모드: LIVE 주문 권한 없음' };
  }

  // ── KIS isDemo 확인 ──
  let isDemo = true;
  try {
    const kisConfig = await db.kisConfig.findFirst();
    if (kisConfig) {
      isDemo = kisConfig.isDemo;
    }
  } catch (_e) {
    // DB 조회 실패 시 기본값 유지
  }

  // ── 일일 주문 건수 & 보유 포지션 수 조회 ──
  let dailyOrderCount = 0;
  let openPositions = 0;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    dailyOrderCount = await db.tradeHistory.count({
      where: {
        market,
        tradedAt: { gte: today },
        status: { notIn: ['CANCELLED', 'FAILED'] },
      },
    });
    openPositions = await db.position.count({
      where: { market },
    });
  } catch (_e) {
    // DB 조회 실패 시 0 유지
  }

  // ── 가용금액 ──
  let availableAmount = 0;
  try {
    if (kisClient) {
      if (market === 'DOMESTIC') {
        const balance = await kisClient.getAccountBalance();
        availableAmount = balance.availableAmount;
      } else {
        const balance = await kisClient.getOverseasAccountBalance();
        availableAmount = balance.availableAmount;
      }
    }
  } catch (_e) {
    // 잔고 조회 실패 시 0 유지
  }

  // ── 주문 사전검증 ──
  const validation = validateOrderExecution(
    settings,
    market,
    isDemo,
    signal.price,
    quantity,
    availableAmount,
    dailyOrderCount,
    openPositions,
    'last', // currentPriceField — 해외 검증 로그에서 항상 'last' 사용
    market === 'OVERSEAS' ? signal.priceGapPercent : undefined,
  );

  // 주문 사전검증 로그 (항상 남김)
  addLog('INFO', market, `주문 사전검증: ${signal.stockName} ${signal.signalType}`, {
    market: validation.market,
    tradingMode: validation.tradingMode,
    orderExecutionMode: validation.orderExecutionMode,
    isDemo: validation.isDemo,
    enableOrder: validation.enableOrder,
    allowRealOrder: validation.allowRealOrder,
    killSwitchEnabled: validation.killSwitchEnabled,
    currentPrice: validation.currentPrice,
    currentPriceField: validation.currentPriceField,
    priceGapPercent: validation.priceGapPercent,
    maxPriceGapPercent: validation.maxPriceGapPercent,
    availableAmount: validation.availableAmount,
    calculatedQuantity: validation.calculatedQuantity,
    estimatedOrderAmount: validation.estimatedOrderAmount,
    maxOrderAmount: validation.maxOrderAmount,
    dailyOrderCount: validation.dailyOrderCount,
    maxDailyOrders: validation.maxDailyOrders,
    openPositions: validation.openPositions,
    maxOpenPositions: validation.maxOpenPositions,
    canPlaceOrder: validation.canPlaceOrder,
    blockedReason: validation.blockedReason,
  });

  if (!validation.canPlaceOrder) {
    addLog('RISK', market, `주문 차단: ${validation.blockedReason}`, {
      stockCode: signal.stockCode,
      signalType: signal.signalType,
      strategy: signal.strategy,
      blockedReason: validation.blockedReason,
    });
    // 차단 건도 TradeHistory에 기록
    agentState.ordersAttempted++;
    agentState.ordersBlocked++;
    try {
      await db.tradeHistory.create({
        data: {
          stockCode: signal.stockCode,
          stockName: signal.stockName,
          tradeType: signal.signalType,
          quantity: quantity,
          price: signal.price,
          totalAmount: signal.price * quantity,
          strategy: signal.strategy,
          signalReason: signal.reason,
          status: 'BLOCKED',
          orderNo: '',
          market,
          exchangeCode: exchangeCode || null,
          currency: market === 'OVERSEAS' ? 'USD' : 'KRW',
          source: 'AGENT',
          orderExecutionMode: settings.orderExecutionMode,
          currentPrice: signal.price,
          orderPrice: signal.price,
          msg1: `주문 차단: ${validation.blockedReason}`,
        },
      });
    } catch (dbErr) {
      const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      addLog('ERROR', market, 'BLOCKED 거래내역 저장 실패', { error: errMsg });
      agentState.tradeHistorySaveFailures.push({
        time: new Date(), market, stockCode: signal.stockCode, error: errMsg,
      });
    }
    return { success: false, orderNo: '', message: `주문 차단: ${validation.blockedReason}` };
  }

  // 해외 주문: 거래소 코드 유효성 (기존 로직 유지)
  if (market === 'OVERSEAS') {
    const validExchanges = ['NAS', 'NYS', 'AMS', 'TKS', 'HKS', 'SHS', 'SZS'];
    if (!exchangeCode || !validExchanges.includes(exchangeCode)) {
      addLog('RISK', market, `해외 주문 차단: 유효하지 않은 거래소 코드 (${exchangeCode || '없음'})`, {
        stockCode: signal.stockCode,
        exchangeCode: exchangeCode || '',
      });
      agentState.ordersAttempted++;
      agentState.ordersBlocked++;
      try {
        await db.tradeHistory.create({
          data: {
            stockCode: signal.stockCode, stockName: signal.stockName,
            tradeType: signal.signalType, quantity, price: signal.price,
            totalAmount: signal.price * quantity, strategy: signal.strategy,
            signalReason: signal.reason, status: 'BLOCKED', orderNo: '',
            market, exchangeCode: exchangeCode || null,
            currency: 'USD', source: 'AGENT', orderExecutionMode: settings.orderExecutionMode,
            currentPrice: signal.price, orderPrice: signal.price,
            msg1: `해외 주문 차단: 유효하지 않은 거래소 코드 (${exchangeCode || '없음'})`,
          },
        });
      } catch {}
      return { success: false, orderNo: '', message: `해외 주문 차단: 유효하지 않은 거래소 코드 (${exchangeCode || '없음'})` };
    }
    if (quantity <= 0) {
      addLog('RISK', market, `해외 주문 차단: 수량이 0 이하 (${quantity})`, { stockCode: signal.stockCode });
      agentState.ordersAttempted++;
      agentState.ordersBlocked++;
      try {
        await db.tradeHistory.create({
          data: {
            stockCode: signal.stockCode, stockName: signal.stockName,
            tradeType: signal.signalType, quantity, price: signal.price,
            totalAmount: signal.price * quantity, strategy: signal.strategy,
            signalReason: signal.reason, status: 'BLOCKED', orderNo: '',
            market, exchangeCode: exchangeCode || null,
            currency: 'USD', source: 'AGENT', orderExecutionMode: settings.orderExecutionMode,
            currentPrice: signal.price, orderPrice: signal.price,
            msg1: `해외 주문 차단: 수량이 0 이하 (${quantity})`,
          },
        });
      } catch {}
      return { success: false, orderNo: '', message: `해외 주문 차단: 수량이 0 이하 (${quantity})` };
    }
  }

  // 국내 주문: 거래세션 정책 체크 (DB 저장 설정 기반)
  if (market === 'DOMESTIC') {
    const policy = getDomesticOrderPolicy(signal, settings.allowAfterHoursTrading);
    if (!policy.allowed) {
      addLog('RISK', market, `${signal.stockName} 주문 차단: ${policy.reason}`, {
        stockCode: signal.stockCode,
        signalType: signal.signalType,
        strategy: signal.strategy,
        session: policy.session,
      });
      agentState.ordersAttempted++;
      agentState.ordersBlocked++;
      try {
        await db.tradeHistory.create({
          data: {
            stockCode: signal.stockCode, stockName: signal.stockName,
            tradeType: signal.signalType, quantity, price: signal.price,
            totalAmount: signal.price * quantity, strategy: signal.strategy,
            signalReason: signal.reason, status: 'BLOCKED', orderNo: '',
            market, exchangeCode: null, currency: 'KRW',
            source: 'AGENT', orderExecutionMode: settings.orderExecutionMode,
            currentPrice: signal.price, orderPrice: signal.price,
            msg1: `주문 차단: ${policy.reason}`,
          },
        });
      } catch {}
      return { success: false, orderNo: '', message: `주문 차단: ${policy.reason}` };
    }
  }

  const safeQuantity = Math.max(1, Math.floor(quantity));
  // ── 주문용 종목코드 정규화 (안전장치) ──
  const orderStockCode = normalizeStockCode(signal.stockCode);
  if (orderStockCode !== signal.stockCode) {
    addLog('INFO', market, `주문 종목코드 정규화: ${signal.stockCode} → ${orderStockCode}`);
  }
  const orderRequest: OrderRequest = {
    stockCode: orderStockCode,
    orderType: signal.signalType as 'BUY' | 'SELL',
    quantity: safeQuantity,
    price: signal.price,
    orderKind: '01', // 시장가
    market,
    exchangeCode,
  };

  let orderNo = '';
  let status = 'PENDING';
  let message = '';
  let rtCd = '';
  let msgCd = '';
  let msg1 = '';

  // KIS API로 주문 실행
  if (kisClient) {
    try {
      const result = market === 'OVERSEAS'
        ? await kisClient.placeOverseasOrder(orderRequest)
        : await kisClient.placeOrder(orderRequest);

      orderNo = result.orderNo;
      status = result.status;
      message = result.message;
      rtCd = result.rt_cd || '';
      msgCd = result.msg_cd || '';
    } catch (error) {
      orderNo = '';
      status = 'FAILED';
      message = `주문 실패: ${error instanceof Error ? error.message : 'Unknown'}`;
      msg1 = error instanceof Error ? error.message : String(error);
      addLog('ERROR', market, `${signal.stockName} 주문 실패`, {
        error: error instanceof Error ? error.message : String(error),
        stockCode: signal.stockCode,
        quantity: safeQuantity,
        price: signal.price,
      });
    }
  } else {
    // KIS 미설정 상태에서는 주문을 실행하지 않음
    addLog('ERROR', market, 'KIS 클라이언트 없음: 주문 불가', {
      stockCode: signal.stockCode,
      signalType: signal.signalType,
    });
    // KIS 미연결 건도 TradeHistory에 기록
    agentState.ordersAttempted++;
    agentState.ordersBlocked++;
    try {
      await db.tradeHistory.create({
        data: {
          stockCode: signal.stockCode,
          stockName: signal.stockName,
          tradeType: signal.signalType,
          quantity: safeQuantity,
          price: signal.price,
          totalAmount: signal.price * safeQuantity,
          strategy: signal.strategy,
          signalReason: signal.reason,
          status: 'BLOCKED',
          orderNo: '',
          market,
          exchangeCode: exchangeCode || null,
          currency: market === 'OVERSEAS' ? 'USD' : 'KRW',
          source: 'AGENT',
          orderExecutionMode: settings.orderExecutionMode,
          currentPrice: signal.price,
          orderPrice: signal.price,
          msg1: 'KIS API 미연결: 주문 불가',
        },
      });
    } catch (dbErr) {
      addLog('ERROR', market, 'BLOCKED(KIS미연결) 거래내역 저장 실패', {
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
    return { success: false, orderNo: '', message: 'KIS API 미연결: 주문을 실행할 수 없습니다. API 설정을 완료하고 토큰을 발급받으세요.' };
  }

  // 주문 실패 시 TradeHistory에 기록 후 종료
  if (status === 'FAILED') {
    agentState.ordersAttempted++;
    agentState.ordersFailed++;
    try {
      await db.tradeHistory.create({
        data: {
          stockCode: signal.stockCode,
          stockName: signal.stockName,
          tradeType: signal.signalType,
          quantity: safeQuantity,
          price: signal.price,
          totalAmount: signal.price * safeQuantity,
          strategy: signal.strategy,
          signalReason: signal.reason,
          status: 'FAILED',
          orderNo,
          market,
          exchangeCode: exchangeCode || null,
          currency: market === 'OVERSEAS' ? 'USD' : 'KRW',
          source: 'AGENT',
          orderExecutionMode: settings.orderExecutionMode,
          currentPrice: signal.price,
          orderPrice: signal.price,
          rtCd,
          msgCd,
          msg1: msg1 || message,
        },
      });
    } catch (dbErr) {
      const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      addLog('ERROR', market, 'FAILED 거래내역 저장 실패', { error: errMsg });
      agentState.tradeHistorySaveFailures.push({
        time: new Date(), market, stockCode: signal.stockCode, error: errMsg,
      });
    }
    return { success: false, orderNo, message };
  }

  // 거래 내역 DB 기록 (PENDING / FILLED)
  agentState.ordersAttempted++;
  if (status === 'FILLED') {
    agentState.ordersFilled++;
    agentState.totalTrades++;
  } else {
    agentState.ordersSubmitted++;
  }
  try {
    await db.tradeHistory.create({
      data: {
        stockCode: signal.stockCode,
        stockName: signal.stockName,
        tradeType: signal.signalType,
        quantity: safeQuantity,
        price: signal.price,
        totalAmount: signal.price * safeQuantity,
        strategy: signal.strategy,
        signalReason: signal.reason,
        status,
        orderNo,
        market,
        exchangeCode: exchangeCode || null,
        currency: market === 'OVERSEAS' ? 'USD' : 'KRW',
        // 주문 출처 및 실행 모드
        source: 'AGENT',
        orderExecutionMode: settings.orderExecutionMode,
        // 가격 상세
        currentPrice: signal.price, // 주문 직전 실시간 현재가 (signal.price에 이미 반영됨)
        orderPrice: signal.price,
        filledPrice: status === 'FILLED' ? signal.price : null,
        avgFillPrice: status === 'FILLED' ? signal.price : null,
        slippagePercent: null,
        // KIS API 응답
        rtCd,
        msgCd,
        msg1,
      },
    });
  } catch (dbError) {
    const errMsg = dbError instanceof Error ? dbError.message : String(dbError);
    addLog('ERROR', market, '거래 내역 저장 실패', {
      error: errMsg,
      stockCode: signal.stockCode,
      status,
      orderNo,
    });
    agentState.tradeHistorySaveFailures.push({
      time: new Date(), market, stockCode: signal.stockCode, error: errMsg,
    });
  }

  // 포지션 DB 업데이트: status === 'FILLED'일 때만 반영
  if (status === 'FILLED') {
    try {
      if (signal.signalType === 'BUY') {
        const positionId = `${market}-${exchangeCode || 'KR'}-${signal.stockCode}`;
        await db.position.upsert({
          where: {
            id: positionId,
          },
          create: {
            id: positionId,
            stockCode: signal.stockCode,
            stockName: signal.stockName,
            quantity: safeQuantity,
            avgPrice: signal.price,
            currentPrice: signal.price,
            profitLoss: 0,
            profitRate: 0,
            strategy: signal.strategy,
            market,
            exchangeCode: exchangeCode || null,
            currency: market === 'OVERSEAS' ? 'USD' : 'KRW',
          },
          update: {
            quantity: { increment: safeQuantity },
            currentPrice: signal.price,
          },
        });
      } else if (signal.signalType === 'SELL') {
        // 매도 시 포지션 삭제 또는 수량 감소
        const positionId = `${market}-${exchangeCode || 'KR'}-${signal.stockCode}`;
        const existingPos = await db.position.findUnique({
          where: { id: positionId },
        });
        if (existingPos) {
          if (existingPos.quantity <= safeQuantity) {
            await db.position.delete({
              where: { id: positionId },
            });
          } else {
            await db.position.update({
              where: { id: positionId },
              data: {
                quantity: existingPos.quantity - safeQuantity,
                currentPrice: signal.price,
              },
            });
          }
        }
      }
    } catch (posError) {
      addLog('ERROR', market, '포지션 업데이트 실패', {
        error: posError instanceof Error ? posError.message : String(posError),
      });
    }
  }

  // PENDING: success true 반환, 포지션 DB는 업데이트하지 않음
  // FILLED: success true 반환, 포지션 DB 업데이트 완료
  return { success: true, orderNo, message: `주문 접수 (${status}) - ${message}` };
}

/**
 * 포지션 모니토링 - 손절/익절/트레일링스톱 체크
 */
async function monitorPositions(
  kisClient: KisApiClient | null,
  market: MarketType,
  settings: EffectiveTradingSettings
): Promise<number> {
  let exitsExecuted = 0;

  // autoExitEnabled=false 기본 — 전략 검증 완료 전까지 자동 청산 비활성화
  // (avgPrice vs currentPrice 차이는 손익률이지 priceAnomaly가 아님)
  if (settings.autoExitEnabled === false) {
    addLog('INFO', market,
      `자동 청산 비활성화(autoExitEnabled=false) — 손절/익절/트레일링 미실행`,
      { autoExitEnabled: false }
    );
    return 0;
  }

  const riskConfig = buildRiskConfigFromSettings(settings, market);
  const riskManager = new RiskManager(riskConfig, market);

  const { positions } = await fetchPositions(kisClient, market);

  for (const position of positions) {
    try {
      // 손절/익절 체크
      // highSinceEntry: 실제 추적값이 없으면 현재가와 진입가 중 높은 값 사용
      // (과거 고점을 모르면 현재가를 고점으로 간주 — 트레일링 스톱이 과도하게 조이는 것 방지)
      const estimatedHighSinceEntry = Math.max(position.currentPrice, position.avgPrice);
      // 전략 감지: stockCode 접두사가 아닌 DB의 position.strategy 필드 사용
      const positionStrategy = (position as any).strategy ||
        (market === 'DOMESTIC' ? 'COMPOSITE' : 'SUPER_TREND');

      const exitCheck = riskManager.checkPositionExit(
        position,
        position.currentPrice,
        position.avgPrice,
        estimatedHighSinceEntry,
        positionStrategy
      );

      if (exitCheck.shouldExit) {
        // ── 자동 청산 사전 차단 조건 (가격 소스 불일치/데이터 오류만 차단) ──
        // avgPrice vs currentPrice 차이는 손익률이지 priceAnomaly가 아님!
        // 차단 조건: priceMismatch=true (평균단가 신뢰 불가)
        if ((position as any).priceMismatch === true) {
          addLog('RISK', market,
            `⚠️ 자동 청산 차단: ${position.stockName} priceMismatch=true — 평균단가 신뢰 불가`,
            {
              stockCode: position.stockCode,
              stockName: position.stockName,
              avgPrice: position.avgPrice,
              currentPrice: position.currentPrice,
              originalExitReason: exitCheck.reason,
              blockedBy: 'PRICE_MISMATCH',
              hint: '/api/positions/diagnostics?code=' + position.stockCode + ' 로 확인 후 수동 청산 권장',
            }
          );
          continue; // 청산 금지 — 다음 포지션으로
        }

        addLog('EXIT', market, 
          `${position.stockName} 자동 청산: ${exitCheck.reason} (현재가: ${position.currentPrice})`,
          { stockCode: position.stockCode, reason: exitCheck.reason, price: position.currentPrice }
        );

        // 매도 주문 실행
        const sellSignal: TradingSignal = {
          stockCode: position.stockCode,
          stockName: position.stockName,
          signalType: 'SELL',
          strategy: 'RISK_EXIT',
          confidence: 90,
          price: position.currentPrice,
          reason: exitCheck.reason,
          indicators: {},
          timestamp: new Date(),
          priceAnomaly: false,
        };

        const result = await executeOrder(
          kisClient,
          sellSignal,
          market,
          settings,
          position.exchangeCode,
          position.quantity
        );

        if (result.success) {
          exitsExecuted++;
          addLog('TRADE', market, 
            `${position.stockName} 청산 주문 접수: ${position.quantity}주 (${result.orderNo})`,
            { orderNo: result.orderNo, quantity: position.quantity, reason: exitCheck.reason }
          );
        }
      }
    } catch (error) {
      addLog('ERROR', market, `${position.stockName} 포지션 모니토링 오류`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return exitsExecuted;
}

/**
 * 포지션 동기화 (Reconciliation)
 * KIS 잔고 API에서 실제 보유 종목을 가져와 로컬 DB와 동기화
 * 주문 후 낙관적 업데이트된 포지션을 실제 잔고 기준으로 보정
 * - 잔고에 있고 DB에 없으면 추가 (이미 보유 중인 종목)
 * - 잔고에 없고 DB에 있으면 삭제 (전량 매도된 종목)
 * - 수량/가격 불일치 시 잔고 기준으로 업데이트
 */
async function reconcilePositions(
  kisClient: KisApiClient | null,
  market: MarketType
): Promise<{ synced: number; added: number; removed: number }> {
  if (!kisClient) return { synced: 0, added: 0, removed: 0 };

  let synced = 0;
  let added = 0;
  let removed = 0;

  try {
    const { positions: actualPositions } = await fetchPositions(kisClient, market);

    // 잔고에 있는 종목 ID 집합
    const actualIds = new Set(
      actualPositions.map(p => `${market}-${p.exchangeCode || 'KR'}-${p.stockCode}`)
    );

    // DB에서 현재 마켓의 포지션 조회
    // 스키마 mismatch(highSinceEntry 등 v2 컬럼 누락) 시에도 동기화가 멈추지 않도록
    // select로 안전한 컬럼만 명시적으로 지정
    let dbPositions: any[] = [];
    try {
      dbPositions = await db.position.findMany({
        where: { market },
        // v2 컬럼이 DB에 없을 수 있으므로 명시적 select 사용
        // (Prisma는 스키마에 정의된 모든 컬럼을 SELECT 하는데,
        //  DB에 컬럼이 없으면 에러 → select로 안전한 컬럼만 지정)
        select: {
          id: true,
          stockCode: true,
          stockName: true,
          quantity: true,
          avgPrice: true,
          currentPrice: true,
          profitLoss: true,
          profitRate: true,
          strategy: true,
          market: true,
          exchangeCode: true,
          currency: true,
          source: true,
          openedAt: true,
          updatedAt: true,
        },
      });
    } catch (posQueryError) {
      const errMsg = posQueryError instanceof Error ? posQueryError.message : String(posQueryError);
      // 스키마 mismatch 감지: Position v2 컬럼이 DB에 없는 경우
      if (errMsg.includes('does not exist') || errMsg.includes('column') || errMsg.includes('highSinceEntry')) {
        addLog('ERROR', market,
          `⚠️ Position 테이블 스키마 불일치 — Railway DB에 v2 컬럼이 없습니다. ` +
          `start.sh의 prisma migrate deploy가 실행되었는지 확인하세요. 동기화를 건너뜁니다.`,
          { error: errMsg, hint: 'prisma migrate deploy 실행 필요' }
        );
      } else {
        addLog('ERROR', market, '포지션 DB 조회 실패 — 동기화 건너뜀', { error: errMsg });
      }
      // 동기화 실패해도 에이전트 사이클은 계속 진행
      return { synced: 0, added: 0, removed: 0 };
    }

    // 1. 잔고에 없는 포지션 삭제 (전량 매도 또는 체결 실패)
    for (const dbPos of dbPositions) {
      if (!actualIds.has(dbPos.id)) {
        await db.position.delete({ where: { id: dbPos.id } }).catch(() => {});
        removed++;
        addLog('INFO', market, `포지션 동기화: ${dbPos.stockName} 삭제 (잔고에 없음)`, {
          stockCode: dbPos.stockCode,
        });
      }
    }

    // 2. 잔고에 있는 종목 upsert
    for (const pos of actualPositions) {
      const positionId = `${market}-${pos.exchangeCode || 'KR'}-${pos.stockCode}`;
      const dbPos = dbPositions.find(p => p.id === positionId);

      // ── 단가 sanity check ──
      // avgPrice <= 0 이면 저장/갱신 금지 (잘못된 단가가 퍼지는 것 방지)
      if (!pos.avgPrice || pos.avgPrice <= 0) {
        addLog('RISK', market,
          `${pos.stockName}(${pos.stockCode}) avgPrice가 유효하지 않음 (${pos.avgPrice}) — 저장 건너뜀`,
          { stockCode: pos.stockCode, avgPrice: pos.avgPrice, rawAvgPriceField: (pos as any).rawAvgPriceField }
        );
        continue;
      }

      // 단가 괴리 (avgPrice vs calculatedAvgPrice from 매입금액/수량) 30% 초과 시 저장 금지
      if ((pos as any).priceMismatch === true) {
        addLog('RISK', market,
          `${pos.stockName}(${pos.stockCode}) 단가 괴리 감지 — 저장 건너뜀: ${(pos as any).mismatchReason}`,
          {
            stockCode: pos.stockCode,
            avgPrice: pos.avgPrice,
            calculatedAvgPrice: (pos as any).calculatedAvgPrice,
            purchaseAmount: (pos as any).purchaseAmount,
            reason: (pos as any).mismatchReason,
          }
        );
        continue;
      }

      // currentPrice를 avgPrice로 저장하지 않는 안전장치
      // (pos.avgPrice가 KIS pchs_avg_pric에서 온 값이므로 pos.currentPrice와 다름)
      const safeAvgPrice = pos.avgPrice;
      const safeCurrentPrice = pos.currentPrice ?? null;

      if (!dbPos) {
        // DB에 없는 새 포지션 (수동 매수 또는 이전 세션에서 보유)
        await db.position.create({
          data: {
            id: positionId,
            stockCode: pos.stockCode,
            stockName: pos.stockName,
            quantity: pos.quantity,
            avgPrice: safeAvgPrice,
            currentPrice: safeCurrentPrice,
            profitLoss: pos.profitLoss,
            profitRate: pos.profitRate,
            strategy: 'MANUAL',
            market,
            exchangeCode: pos.exchangeCode || null,
            currency: pos.currency || (market === 'OVERSEAS' ? 'USD' : 'KRW'),
            source: (pos as any).source || 'KIS_BALANCE',
          },
        }).catch(() => {});
        added++;
      } else {
        // 수량/가격 업데이트
        if (dbPos.quantity !== pos.quantity
          || Math.abs(dbPos.currentPrice - pos.currentPrice) > 0
          || Math.abs(dbPos.avgPrice - pos.avgPrice) > 0
          || (dbPos as any).source !== ((pos as any).source || 'KIS_BALANCE')) {
          await db.position.update({
            where: { id: positionId },
            data: {
              quantity: pos.quantity,
              avgPrice: safeAvgPrice,
              currentPrice: safeCurrentPrice,
              profitLoss: pos.profitLoss,
              profitRate: pos.profitRate,
              source: (pos as any).source || 'KIS_BALANCE',
            },
          }).catch(() => {});
          synced++;
        }
      }
    }

    if (added > 0 || removed > 0 || synced > 0) {
      addLog('INFO', market, `포지션 동기화 완료: 추가 ${added}, 삭제 ${removed}, 업데이트 ${synced}`, {
        added, removed, synced,
      });
    }
  } catch (error) {
    addLog('ERROR', market, '포지션 동기화 실패', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { synced, added, removed };
}

/**
 * stocksAnalyzed가 0일 때 원인을 진단하여 반환
 */
function diagnoseZeroAnalysis(
  kisConfig: KisConfig | null,
  kisClient: KisApiClient | null,
  domesticStocks: number,
  overseasStocks: number,
  domesticSuccess: number,
  domesticFailed: number,
  candleErrors: string[]
): string {
  const reasons: string[] = [];

  if (!kisConfig) {
    reasons.push('KIS 설정 없음');
  } else if (!kisClient) {
    reasons.push('KIS 토큰 없음 (연결 실패)');
  }

  if (kisClient && domesticStocks > 0 && domesticSuccess === 0 && domesticFailed > 0) {
    reasons.push(`캔들 조회 실패 (${domesticFailed}종목)`);
  }

  if (kisClient && domesticStocks > 0 && domesticFailed === 0 && domesticSuccess === 0) {
    reasons.push('캔들 개수 30개 미만');
  }

  if (domesticStocks === 0 && overseasStocks === 0) {
    reasons.push('분석 대상 종목 없음');
  }

  // 장외 시간 체크
  const session = getDomesticSession();
  if (session.session === 'CLOSED') {
    reasons.push('장외 시간 (주문 차단됨)');
  }

  if (candleErrors.length > 0) {
    reasons.push(`캔들 에러: ${candleErrors.slice(0, 3).join(', ')}${candleErrors.length > 3 ? ` 외 ${candleErrors.length - 3}건` : ''}`);
  }

  return reasons.length > 0 ? reasons.join(' | ') : '원인 불명';
}

/**
 * 에이전트 1사이클 실행
 * 시그널 분석 → 리스크 체크 → 주문 실행 → 포지션 모니토링
 */
export async function runAgentCycle(): Promise<AgentCycleResult> {
  const startTime = new Date();
  const errors: string[] = [];
  let stocksAnalyzed = 0;
  let signalsGenerated = 0;
  let ordersPlaced = 0;
  let positionsMonitored = 0;
  let exitsExecuted = 0;

  // 분석 성공/실패 카운트
  let domesticSuccess = 0;
  let domesticFailed = 0;
  let overseasSuccess = 0;
  let overseasFailed = 0;
  const candleErrors: string[] = [];

  addLog('INFO', 'DOMESTIC', '자동 분석 사이클 시작');

  // 0. DB 저장 설정 로드 (DB > 환경변수 > 안전 기본값)
  const { settings: effectiveSettings, source: settingsSource } = await getEffectiveTradingSettings();
  const runtime = computeRuntimeDecision(effectiveSettings);

  addLog('INFO', 'DOMESTIC', `실행 설정 로드 완료 (source=${settingsSource}): ${formatSettingsSummary(effectiveSettings)}`);
  addLog('INFO', 'DOMESTIC', `런타임 판단: 분석=${runtime.canRunAnalysisNow ? '허용' : '차단(' + runtime.analysisBlockedReason + ')'}, 국내주문=${runtime.canPlaceDomesticOrderNow ? '허용' : '차단(' + runtime.domesticOrderBlockedReason + ')'}, 해외주문=${runtime.canPlaceOverseasOrderNow ? '허용' : '차단(' + runtime.overseasOrderBlockedReason + ')'}`);

  // autoAnalysisEnabled=false면 분석 자체를 건너뜀
  if (!effectiveSettings.autoAnalysisEnabled) {
    addLog('INFO', 'DOMESTIC', '자동 분석 비활성화 (autoAnalysisEnabled=false), 사이클 건너뜀');
    const endTime = new Date();
    return {
      success: true, startTime, endTime,
      stocksAnalyzed: 0, signalsGenerated: 0, ordersPlaced: 0,
      positionsMonitored: 0, exitsExecuted: 0, logs: agentState.logs.slice(0, 10), errors: [],
      domesticSuccess: 0, domesticFailed: 0, overseasSuccess: 0, overseasFailed: 0,
      zeroAnalysisReason: 'autoAnalysisEnabled=false',
    };
  }

  // runAnalysisOnlyDuringMarketHours=true + 장외면 분석 건너뜀
  if (effectiveSettings.runAnalysisOnlyDuringMarketHours) {
    const domesticOpen = getDomesticSession().session === 'REGULAR';
    if (!domesticOpen) {
      addLog('INFO', 'DOMESTIC', `분석 차단: runAnalysisOnlyDuringMarketHours=true + 장외`);
      const endTime = new Date();
      return {
        success: true, startTime, endTime,
        stocksAnalyzed: 0, signalsGenerated: 0, ordersPlaced: 0,
        positionsMonitored: 0, exitsExecuted: 0, logs: agentState.logs.slice(0, 10), errors: [],
        domesticSuccess: 0, domesticFailed: 0, overseasSuccess: 0, overseasFailed: 0,
        zeroAnalysisReason: 'runAnalysisOnlyDuringMarketHours + 장외',
      };
    }
  }

  // 1. KIS 설정 로드
  const kisConfig = await loadKisConfig();
  let kisClient: KisApiClient | null = null;

  if (kisConfig) {
    try {
      kisClient = new KisApiClient(kisConfig);
      await kisClient.ensureToken();
      addLog('INFO', 'DOMESTIC', 'KIS API 연결 성공');
      
      // 토큰 갱신 내용을 DB에도 업데이트 (getTokenInfo 공식 메서드 사용)
      const tokenInfo = kisClient.getTokenInfo();
      if (tokenInfo.accessToken && tokenInfo.tokenExpiresAt) {
        const configRecord = await db.kisConfig.findFirst();
        if (configRecord) {
          await db.kisConfig.update({
            where: { id: configRecord.id },
            data: {
              accessToken: tokenInfo.accessToken,
              tokenExpiresAt: tokenInfo.tokenExpiresAt,
            },
          });
        }
      }
    } catch (error) {
      addLog('ERROR', 'DOMESTIC', 'KIS API 연결 실패 - 실제 매매 불가', {
        error: error instanceof Error ? error.message : String(error),
      });
      kisClient = null;
    }
  } else {
    addLog('INFO', 'DOMESTIC', 'KIS 설정 없음 - 실제 매매 불가 (신호 분석만 수행)');
  }

  // 2. 분석 대상 종목 로드 (보유종목 + 관심종목 + 우량 대형주)
  const { domestic: domesticStocks, overseas: overseasStocks } = await loadTargetStocks(kisClient, effectiveSettings);
  addLog('INFO', 'DOMESTIC', `분석 대상: 국내 ${domesticStocks.length}개, 해외 ${overseasStocks.length}개`);

  // 3. 리스크 매니저 초기화 (DB 저장 리스크 설정 + strategyAggressiveness 기반 신뢰도 임계값)
  const domesticRisk = new RiskManager(
    buildRiskConfigFromSettings(effectiveSettings, 'DOMESTIC'),
    'DOMESTIC',
    effectiveSettings.minConfidenceThreshold,
  );
  const overseasRisk = new RiskManager(
    buildRiskConfigFromSettings(effectiveSettings, 'OVERSEAS'),
    'OVERSEAS',
    effectiveSettings.minConfidenceThreshold,
  );

  addLog('INFO', 'DOMESTIC', `전략 공격성: ${effectiveSettings.strategyAggressiveness} (signalThreshold=${effectiveSettings.signalThreshold}, weakThreshold=${effectiveSettings.weakSignalThreshold}, minConfidence=${effectiveSettings.minConfidenceThreshold}%)`);

  // ── 진단 추적용 상태 ──
  let uiSignalsCount = 0;          // TradingEngine이 생성한 BUY/SELL 신호 수 (HOLD 제외)
  let executableSignalsCount = 0;  // 리스크 매니저 통과한 실행 가능 신호 수
  const signalsBlockedReasons: string[] = [];  // 신호 차단 사유 수집
  const topBuyCandidates: Array<{stockCode: string; stockName: string; confidence: number; signalType: string; buyScore?: number; sellScore?: number; finalThreshold?: number; blockedReason?: string; holdReason?: string}> = [];

  // ── FORCE_TEST_SIGNAL ──
  // PAPER 모드에서 주문 파이프라인 검증용: 1개 BUY 신호 강제 주입
  // LIVE/REAL 모드에서는 절대 활성화 불가
  const FORCE_TEST_SIGNAL = process.env.FORCE_TEST_SIGNAL === 'true' && effectiveSettings.orderExecutionMode === 'PAPER';
  if (FORCE_TEST_SIGNAL) {
    if (effectiveSettings.orderExecutionMode === 'LIVE' || effectiveSettings.tradingMode === 'REAL') {
      addLog('RISK', 'DOMESTIC', 'FORCE_TEST_SIGNAL은 LIVE/REAL 모드에서 사용할 수 없습니다. 무시됩니다.');
    } else {
      addLog('RISK', 'DOMESTIC', '⚠️ FORCE_TEST_SIGNAL 활성화: 파이프라인 검증용 1회 소액 주문이 실행될 수 있습니다', {
        orderExecutionMode: effectiveSettings.orderExecutionMode,
        maxDomesticOrderAmount: effectiveSettings.maxDomesticOrderAmount,
      });
    }
  }
  let forceTestSignalUsed = false;

  // 4. 현재 포지션 조회
  const domesticPositions = await fetchPositions(kisClient, 'DOMESTIC');

  // ── 포지션 조회 실패 감지 ──
  // KIS 클라이언트가 있는데도 잔고/포지션이 0이면 조회 실패 가능성
  // PAPER+DEMO 모드에서는 주문 차단하지 않음 (소액 주문 검증이 목적)
  let positionQueryFailed = false;
  let positionQueryFailedReason = '';
  if (kisClient && domesticPositions.positions.length === 0 && domesticPositions.accountBalance === 0) {
    positionQueryFailed = true;
    const isPaperDemo = effectiveSettings.orderExecutionMode === 'PAPER' && effectiveSettings.tradingMode === 'DEMO';
    if (isPaperDemo) {
      positionQueryFailedReason = '국내 포지션/잔고 조회 결과 0 (PAPER+DEMO: 소액 주문 허용)';
      addLog('RISK', 'DOMESTIC', `⚠️ ${positionQueryFailedReason}`, {
        positionsCount: domesticPositions.positions.length,
        accountBalance: domesticPositions.accountBalance,
        hasKisClient: !!kisClient,
        orderExecutionMode: effectiveSettings.orderExecutionMode,
        note: 'PAPER 모의투자에서는 잔고 조회 실패해도 maxDomesticOrderAmount 이하 주문 허용',
      });
    } else {
      positionQueryFailedReason = '국내 포지션/잔고 조회 결과가 0 — KIS API 연결 문제 가능성';
      addLog('RISK', 'DOMESTIC', `⚠️ ${positionQueryFailedReason}`, {
        positionsCount: domesticPositions.positions.length,
        accountBalance: domesticPositions.accountBalance,
        hasKisClient: !!kisClient,
      });
    }
  }

  // ========================================
  // 국내주식 분석 & 매매
  // ========================================
  addLog('INFO', 'DOMESTIC', '국내주식 분석 시작');

  for (const stock of domesticStocks) {
    try {
      // 캔들 데이터 조회
      const { candles, error: candleError } = await fetchCandles(kisClient, stock.code, stock.name, 'DOMESTIC');

      if (candleError) {
        domesticFailed++;
        candleErrors.push(`${stock.name}: ${candleError}`);
        // 실패해도 다음 종목으로 계속
        continue;
      }

      if (candles.length < 30) {
        domesticFailed++;
        addLog('INFO', 'DOMESTIC', `${stock.name} 데이터 부족 (캔들 ${candles.length}개, 최소 30개 필요)`, {
          stockCode: stock.code,
          candlesLength: candles.length,
          lastClose: candles.length > 0 ? candles[candles.length - 1].close : null,
        });
        continue;
      }

      domesticSuccess++;
      stocksAnalyzed++;

      // 전략 분석 (strategyAggressiveness 기반 동적 임계값 적용)
      // selectedStrategy(COMPOSITE/ALL 등)를 실제로 반영 — 'ALL' 하드코딩 제거
      const signal = TradingEngine.analyze(
        candles, stock.code, stock.name, effectiveSettings.selectedStrategy || 'ALL', 'DOMESTIC',
        {}, // userParams
        effectiveSettings.signalThreshold,
        effectiveSettings.weakSignalThreshold,
      );

      // ── 가격 anomaly 검증 (단가 괴리 20% 이상 시 주문/청산 차단) ──
      // 분석가(캔들 종가 = signal.price) vs KIS 실시간 현재가 비교
      // 사용자 신고: 삼성전자 캔들 lastClose=370,750 vs 실시간 70,100 → 428% 괴리
      let domesticCurrentPrice = 0;
      let domesticPriceAnomalyResult: ReturnType<typeof checkPriceAnomaly> | null = null;
      if (kisClient && signal.price > 0) {
        try {
          const rtPrice = await kisClient.getStockPrice(stock.code);
          domesticCurrentPrice = rtPrice.currentPrice || 0;
          domesticPriceAnomalyResult = checkPriceAnomaly(
            signal.price, // 분석 기준가 (캔들 lastClose)
            domesticCurrentPrice,
            stock.code,
            stock.name,
          );
          // signal에 기록 (executeOrder/monitorPositions에서 참조)
          signal.analysisPrice = signal.price;
          signal.currentPrice = domesticCurrentPrice;
          signal.priceAnomaly = domesticPriceAnomalyResult.priceAnomaly;
          signal.anomalyReason = domesticPriceAnomalyResult.anomalyReason;
          signal.anomalyCheckedAt = domesticPriceAnomalyResult.anomalyCheckedAt;
          signal.priceGapPercent = domesticPriceAnomalyResult.gapPercent;
          signal.currentPriceTimestamp = new Date().toISOString();
          signal.dataSource = 'daily_candle+current_price';

          if (domesticPriceAnomalyResult.priceAnomaly) {
            addLog('RISK', 'DOMESTIC',
              `⚠️ 가격 anomaly: ${stock.name} 분석가=${signal.price} vs 실시간=${domesticCurrentPrice} (괴리 ${(domesticPriceAnomalyResult.gapPercent * 100).toFixed(2)}%) — 신규 주문 및 자동 청산 차단`,
              {
                stockCode: stock.code,
                stockName: stock.name,
                analysisPrice: signal.price,
                realtimePrice: domesticCurrentPrice,
                gapPercent: domesticPriceAnomalyResult.gapPercent,
                anomalyReason: domesticPriceAnomalyResult.anomalyReason,
                threshold: PRICE_ANOMALY_THRESHOLD,
                hint: 'KIS 일봉 응답의 stck_clpr 파싱/액면분할/수정주가 혼용 가능성 — /api/price/diagnostics?code=' + stock.code + ' 로 원본 응답 확인 필요',
              }
            );
          } else if (domesticPriceAnomalyResult.gapPercent >= 0.05) {
            // 5~20% 괴리는 INFO 레벨 경고
            addLog('INFO', 'DOMESTIC',
              `가격 괴리 주의: ${stock.name} 분석가=${signal.price} vs 실시간=${domesticCurrentPrice} (괴리 ${(domesticPriceAnomalyResult.gapPercent * 100).toFixed(2)}%)`,
              {
                stockCode: stock.code,
                analysisPrice: signal.price,
                realtimePrice: domesticCurrentPrice,
                gapPercent: domesticPriceAnomalyResult.gapPercent,
              }
            );
          }
        } catch (cpErr) {
          addLog('ERROR', 'DOMESTIC',
            `${stock.name} 현재가 조회 실패 (anomaly 검증 생략): ${cpErr instanceof Error ? cpErr.message : 'Unknown'}`,
            { stockCode: stock.code }
          );
        }
      }

      // 종목별 상세 정보 로그
      const logDetails: Record<string, unknown> = {
        stockCode: stock.code,
        candlesLength: candles.length,
        lastClose: candles[candles.length - 1].close,
        signalType: signal.signalType,
        strategy: signal.strategy,
        signalThreshold: effectiveSettings.signalThreshold,
        weakSignalThreshold: effectiveSettings.weakSignalThreshold,
      };
      if (domesticCurrentPrice > 0) {
        logDetails.realtimePrice = domesticCurrentPrice;
        logDetails.priceGapPercent = domesticPriceAnomalyResult?.gapPercent;
        logDetails.priceAnomaly = domesticPriceAnomalyResult?.priceAnomaly ?? false;
      }

      // HOLD인 경우 holdReason 로그에 추가
      if (signal.signalType === 'HOLD' && signal.holdReason) {
        logDetails.holdReason = signal.holdReason;
        addLog('INFO', 'DOMESTIC', `${stock.name} 분석 결과: HOLD (buyScore=${signal.buyScore ?? '-'}, sellScore=${signal.sellScore ?? '-'}, 임계값=${signal.finalThreshold ?? effectiveSettings.signalThreshold}) — ${signal.holdReason}`, logDetails);
      } else {
        addLog('INFO', 'DOMESTIC', `${stock.name} 분석 결과: ${signal.signalType} (신뢰도: ${signal.confidence}%)`, logDetails);
      }

      // ── priceAnomaly=true인 경우 신규 주문 차단 ──
      if (signal.priceAnomaly && signal.signalType !== 'HOLD') {
        signalsBlockedReasons.push(`${stock.name}: 가격 anomaly (괴리 ${((signal.priceGapPercent ?? 0) * 100).toFixed(2)}%)`);
        addLog('RISK', 'DOMESTIC',
          `주문 차단: ${stock.name} 가격 anomaly — 분석가 ${signal.price} vs 실시간 ${domesticCurrentPrice}`,
          {
            stockCode: stock.code,
            signalType: signal.signalType,
            analysisPrice: signal.price,
            realtimePrice: domesticCurrentPrice,
            gapPercent: signal.priceGapPercent,
            anomalyReason: signal.anomalyReason,
            blockedBy: 'PRICE_ANOMALY',
          }
        );
        continue; // 다음 종목으로
      }

      // BUY/SELL/HOLD 모두 후보 추적 (진단용)
      if (signal.signalType !== 'HOLD') {
        uiSignalsCount++;
      }
      // 상위 후보 추적 (BUY/SELL + HOLD 중 buyScore가 높은 것)
      topBuyCandidates.push({
        stockCode: stock.code,
        stockName: stock.name,
        confidence: signal.confidence,
        signalType: signal.signalType,
        buyScore: signal.buyScore,
        sellScore: signal.sellScore,
        finalThreshold: signal.finalThreshold ?? effectiveSettings.signalThreshold,
        holdReason: signal.holdReason,
      });

      // ── FORCE_TEST_SIGNAL: 첫 번째 BUY 후보에 강제 BUY 주입 ──
      if (FORCE_TEST_SIGNAL && !forceTestSignalUsed && signal.signalType === 'HOLD' && domesticStocks.indexOf(stock) === 0) {
        // 첫 번째 종목에 대해 강제 BUY 신호 주입
        const forcedSignal: TradingSignal = {
          stockCode: stock.code,
          stockName: stock.name,
          signalType: 'BUY',
          strategy: 'FORCE_TEST',
          confidence: effectiveSettings.minConfidenceThreshold,  // 최소 신뢰도로 설정
          price: signal.price,
          reason: `FORCE_TEST_SIGNAL 파이프라인 검증 (원래: ${signal.signalType}, 신뢰도: ${signal.confidence}%)`,
          indicators: { ...signal.indicators, forceTest: 1 },
          timestamp: new Date(),
        };
        // signal을 강제 BUY로 교체
        Object.assign(signal, forcedSignal);
        forceTestSignalUsed = true;
        addLog('SIGNAL', 'DOMESTIC', `⚠️ FORCE_TEST_SIGNAL: ${stock.name} 강제 BUY 신호 주입 (파이프라인 검증용)`, {
          stockCode: stock.code,
          originalSignalType: 'HOLD',
          originalConfidence: signal.confidence,
          forcedConfidence: effectiveSettings.minConfidenceThreshold,
        });
      }

      if (signal.signalType !== 'HOLD') {
        signalsGenerated++;
        addLog('SIGNAL', 'DOMESTIC', 
          `${stock.name} ${signal.signalType} 신호 (신뢰도: ${signal.confidence}%) - ${signal.reason}`,
          { signalType: signal.signalType, confidence: signal.confidence, price: signal.price, strategy: signal.strategy }
        );

        // AI 분석으로 신호 검증 (비동기, 실패 시 기술적 신호만 사용)
        let finalSignal = signal;
        try {
          const aiResult = await aiAnalyzer.analyzeStock(
            stock.name, stock.code, 'DOMESTIC', signal
          );
          if (aiResult.confidence > 0) {
            finalSignal = aiAnalyzer.combineSignals(signal, aiResult);
            addLog('SIGNAL', 'DOMESTIC',
              `${stock.name} AI 검증: ${signal.signalType}→${finalSignal.signalType} (신뢰도: ${signal.confidence}%→${finalSignal.confidence}%) - AI심리: ${aiResult.sentiment}`,
              { aiRecommendation: aiResult.recommendation, aiConfidence: aiResult.confidence, aiRiskLevel: aiResult.riskLevel }
            );
          }
        } catch (aiError) {
          // AI 분석 실패는 무시하고 기술적 신호만 사용
          addLog('INFO', 'DOMESTIC', `${stock.name} AI 분석 스킵 (기술적 신호만 사용)`);
        }

        // AI 검증 후 HOLD로 변경된 경우 매매 차단
        if (finalSignal.signalType === 'HOLD') {
          addLog('RISK', 'DOMESTIC', `${stock.name} AI 검증 결과 HOLD로 변경 - 매매 차단`);
          continue;
        }

        // ── 사전 필터: 미보유 SELL → 매수 회피 신호로만 기록, 주문 파이프라인 진입 금지 ──
        if (finalSignal.signalType === 'SELL') {
          const isHeld = domesticPositions.positions.find(p => p.stockCode === stock.code);
          if (!isHeld) {
            addLog('SIGNAL', 'DOMESTIC',
              `${stock.name} SELL 신호지만 미보유 — 매수 회피 신호로 기록 (주문 불가)`,
              { stockCode: stock.code, sellScore: finalSignal.sellScore, confidence: finalSignal.confidence }
            );
            continue; // 주문 파이프라인 진입 금지
          }
        }

        // ── 사전 필터: BUY 후보 9가지 엄격 조건 ──
        // CONSERVATIVE 모드에서만 적용 (TEST/AGGRESSIVE는 기존 리스크 매니저에 위임)
        if (finalSignal.signalType === 'BUY' && effectiveSettings.strategyAggressiveness === 'CONSERVATIVE') {
          const buyFilter = filterBuyCandidateStrict(
            finalSignal, candles, domesticPositions.positions, effectiveSettings.maxOpenDomesticPositions,
          );
          if (!buyFilter.pass) {
            signalsBlockedReasons.push(`${stock.name}: ${buyFilter.reason}`);
            const candidate = topBuyCandidates.find(c => c.stockCode === stock.code);
            if (candidate) candidate.blockedReason = buyFilter.reason;
            addLog('RISK', 'DOMESTIC',
              `${stock.name} BUY 사전 필터 차단: ${buyFilter.reason}`,
              { stockCode: stock.code, filter: 'strictBuyFilter', reason: buyFilter.reason }
            );
            continue;
          }
        }

        // 리스크 체크
        const riskCheck = domesticRisk.canTrade(
          finalSignal, domesticPositions.positions, domesticPositions.accountBalance
        );

        if (riskCheck.allowed) {
          executableSignalsCount++;

          // 자동 국내 주문 허용 여부 체크
          if (!effectiveSettings.autoDomesticOrderEnabled) {
            signalsBlockedReasons.push(`${stock.name}: autoDomesticOrderEnabled=false`);
            addLog('RISK', 'DOMESTIC',
              `국내 주문 차단: autoDomesticOrderEnabled=false - ${stock.name} ${finalSignal.signalType} 신호 생성만 수행`,
              { stockCode: stock.code, signalType: finalSignal.signalType, price: finalSignal.price }
            );
            continue;
          }

          // 포지션 사이즈 계산 — v2: ATR 기반 리스크 사이징
          const atrValue = finalSignal.indicators?.atr14 || finalSignal.indicators?.atr;
          let quantity = domesticRisk.calculatePositionSize(
            domesticPositions.accountBalance, finalSignal.price, finalSignal.confidence,
            atrValue, effectiveSettings.accountRiskPercent, effectiveSettings.useATRStop,
          );

          // PIPELINE_TEST 모드에서는 항상 1주로 제한
          if (effectiveSettings.strategyAggressiveness === 'PIPELINE_TEST') {
            quantity = 1;
          }

          // STRATEGY_TEST 모드에서 주문금액이 maxDomesticOrderAmount 초과 시
          // 1주 가격이 한도 이내면 1주로 자동 조정 (PIPELINE_TEST와 동일한 fallback)
          // — 고가주(SK하이닉스, 삼성전기 등)가 position sizing 후 차단되는 문제 해결
          const oneShareAmount = finalSignal.price * 1;
          const isStrategyTestPaper = effectiveSettings.strategyAggressiveness === 'STRATEGY_TEST'
            && effectiveSettings.orderExecutionMode === 'PAPER';
          if (isStrategyTestPaper
            && quantity > 1
            && (finalSignal.price * quantity) > effectiveSettings.maxDomesticOrderAmount
            && oneShareAmount <= effectiveSettings.maxDomesticOrderAmount) {
            const originalQty = quantity;
            quantity = 1;
            addLog('INFO', 'DOMESTIC',
              `${stock.name} 수량 자동 조정: ${originalQty}주 → 1주 ` +
              `(원래 주문금액 ${(finalSignal.price * originalQty).toLocaleString()}원 > 최대 ${effectiveSettings.maxDomesticOrderAmount.toLocaleString()}원, 1주 ${oneShareAmount.toLocaleString()}원은 허용)`,
              { originalQuantity: originalQty, adjustedQuantity: 1, price: finalSignal.price }
            );
          }

          // 주문금액이 maxDomesticOrderAmount 초과 시 (수량 조정 후에도 1주가 한도 초과면 건너뜀)
          const estimatedAmount = finalSignal.price * quantity;
          if (estimatedAmount > effectiveSettings.maxDomesticOrderAmount) {
            signalsBlockedReasons.push(`${stock.name}: 주문금액 초과 (${estimatedAmount.toLocaleString()} > ${effectiveSettings.maxDomesticOrderAmount.toLocaleString()})`);
            const candidate = topBuyCandidates.find(c => c.stockCode === stock.code);
            if (candidate) candidate.blockedReason = `주문금액 초과: ${estimatedAmount.toLocaleString()} > ${effectiveSettings.maxDomesticOrderAmount.toLocaleString()}`;
            addLog('RISK', 'DOMESTIC',
              `${stock.name} 주문금액 초과 — 다음 후보로 이동: ${quantity}주 × ${finalSignal.price}원 = ${estimatedAmount.toLocaleString()} > 최대 ${effectiveSettings.maxDomesticOrderAmount.toLocaleString()}`,
              { estimatedAmount, maxDomesticOrderAmount: effectiveSettings.maxDomesticOrderAmount, quantity, price: finalSignal.price }
            );
            continue;  // 다음 후보 시도
          }

          // 주문 실행
          const result = await executeOrder(kisClient, { ...finalSignal, price: finalSignal.price }, 'DOMESTIC', effectiveSettings, undefined, quantity);

          if (result.success) {
            ordersPlaced++;
            addLog('TRADE', 'DOMESTIC',
              `${stock.name} ${finalSignal.signalType} 주문 접수: ${quantity}주 @ ${finalSignal.price}원 (${result.orderNo})`,
              { orderNo: result.orderNo, quantity, price: finalSignal.price }
            );
          } else {
            addLog('ERROR', 'DOMESTIC',
              `${stock.name} ${finalSignal.signalType} 주문 실패: ${result.message}`,
              { orderNo: result.orderNo, quantity, price: finalSignal.price }
            );
          }
        } else {
          signalsBlockedReasons.push(`${stock.name}: ${riskCheck.reason}`);
          // 차단 사유를 후보에도 기록
          const candidate = topBuyCandidates.find(c => c.stockCode === stock.code);
          if (candidate) candidate.blockedReason = riskCheck.reason;
          addLog('RISK', 'DOMESTIC',
            `${stock.name} 매매 차단: ${riskCheck.reason}`,
            { reason: riskCheck.reason }
          );
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(`국내 ${stock.name}: ${errMsg}`);
      domesticFailed++;
      addLog('ERROR', 'DOMESTIC', `${stock.name} 분석 오류: ${errMsg}`);
      // 개별 종목 오류가 전체 사이클을 죽이지 않음
    }
  }

  addLog('INFO', 'DOMESTIC', `국내 분석 결과: 성공 ${domesticSuccess}종목, 실패 ${domesticFailed}종목, 주문=${runtime.canPlaceDomesticOrderNow ? '허용' : '차단(' + runtime.domesticOrderBlockedReason + ')'}`, {
    domesticSuccess,
    domesticFailed,
    domesticOrderAllowed: runtime.canPlaceDomesticOrderNow,
  });

  // ========================================
  // 해외주식 분석 & 매매 (DB 저장 설정 기반)
  // ========================================
  if (effectiveSettings.enableOverseasAnalysis) {
    addLog('INFO', 'OVERSEAS', `해외주식 분석 시작 (주문=${runtime.canPlaceOverseasOrderNow ? '허용' : '차단(' + runtime.overseasOrderBlockedReason + ')'})`);

    const overseasPositions = await fetchPositions(kisClient, 'OVERSEAS');

    for (const stock of overseasStocks) {
      try {
        // 해외 종목코드 정규화 (SYMB에 "NAS:RKLB" 전체가 들어가지 않도록)
        const { exchangeCode: normExchange, symbol: normalizedSymbol, displayCode } = normalizeOverseasSymbol(stock.code, stock.exchange);

        const { candles, error: candleError } = await fetchCandles(kisClient, stock.code, stock.name, 'OVERSEAS', stock.exchange);

        if (candleError) {
          overseasFailed++;
          candleErrors.push(`해외 ${stock.name}: ${candleError}`);
          continue;
        }

        if (candles.length < 30) {
          overseasFailed++;
          addLog('INFO', 'OVERSEAS', `${stock.name} 데이터 부족 (캔들 ${candles.length}개)`, {
            stockCode: stock.code,
            normalizedSymbol,
            exchangeCode: normExchange,
            candlesLength: candles.length,
            lastClose: candles.length > 0 ? candles[candles.length - 1].close : null,
          });
          continue;
        }

        overseasSuccess++;
        stocksAnalyzed++;

        // 분석 기준가격 = 마지막 일봉 종가
        const analysisPrice = candles[candles.length - 1].close;

        // 해외 현재가 실시간 조회 (분석과 주문 사이 괴리 추적)
        let currentPriceInfo: {
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
        } | null = null;
        let currentPrice = 0;
        let priceGapPercent = 0;
        let currentPriceTimestamp = '';
        let priceDataSource = 'daily_candle';

        if (kisClient) {
          try {
            currentPriceInfo = await kisClient.getOverseasCurrentPrice(stock.code, stock.exchange);
            currentPrice = currentPriceInfo.currentPrice;
            currentPriceTimestamp = currentPriceInfo.timestamp;
            priceDataSource = 'daily_candle+current_price';

            // 괴리율 계산
            if (analysisPrice > 0 && currentPrice > 0) {
              priceGapPercent = Math.abs(currentPrice - analysisPrice) / analysisPrice;
            }

            // 괴리율 5% 이상 경고 로그 (RISK 타입)
            if (priceGapPercent >= 0.05) {
              addLog('RISK', 'OVERSEAS',
                `해외 현재가 괴리율 경고: ${currentPriceInfo.normalizedSymbol || normalizedSymbol} gap=${(priceGapPercent * 100).toFixed(2)}%`,
                {
                  originalStockCode: currentPriceInfo.originalStockCode || stock.code,
                  stockCode: currentPriceInfo.stockCode || stock.code,
                  exchangeCode: currentPriceInfo.exchangeCode || normExchange,
                  normalizedSymbol: currentPriceInfo.normalizedSymbol || normalizedSymbol,
                  analysisPrice,
                  currentPrice: currentPriceInfo.currentPrice,
                  priceGapPercent: parseFloat((priceGapPercent * 100).toFixed(4)),
                  rawPriceFields: currentPriceInfo.rawPriceFields,
                  currentPriceField: currentPriceInfo.currentPriceField || 'last',
                  currentPriceTimestamp: currentPriceInfo.timestamp,
                  source: currentPriceInfo.source || 'KIS_REST',
                }
              );
            }

            addLog('INFO', 'OVERSEAS',
              `[미] ${stock.name} 해외 현재가 조회 성공: ${currentPriceInfo.normalizedSymbol || normalizedSymbol}, currentPrice=${currentPriceInfo.currentPrice}, timestamp=${currentPriceInfo.timestamp}`,
              {
                originalStockCode: currentPriceInfo.originalStockCode || stock.code,
                stockCode: currentPriceInfo.stockCode || stock.code,
                exchangeCode: currentPriceInfo.exchangeCode || normExchange,
                normalizedSymbol: currentPriceInfo.normalizedSymbol || normalizedSymbol,
                rawPriceFields: currentPriceInfo.rawPriceFields,
                currentPriceField: currentPriceInfo.currentPriceField || 'last',
                currentPrice: currentPriceInfo.currentPrice,
                previousClose: currentPriceInfo.previousClose,
                volume: currentPriceInfo.volume,
                analysisPrice,
                priceGapPercent: parseFloat((priceGapPercent * 100).toFixed(4)),
                currentPriceTimestamp: currentPriceInfo.timestamp,
                source: currentPriceInfo.source || 'KIS_REST',
              }
            );
          } catch (cpError) {
            addLog('ERROR', 'OVERSEAS',
              `${stock.name} 해외 현재가 조회 실패: ${cpError instanceof Error ? cpError.message : 'Unknown'}`,
              { stockCode: stock.code, normalizedSymbol, exchangeCode: normExchange }
            );
            // 현재가 조회 실패해도 일봉 분석은 계속 진행
          }
        }

        // 전략 분석 (strategyAggressiveness 기반 동적 임계값 적용)
        // selectedStrategy(COMPOSITE/ALL 등)를 실제로 반영 — 'ALL' 하드코딩 제거
        const signal = TradingEngine.analyze(
          candles, stock.code, stock.name, effectiveSettings.selectedStrategy || 'ALL', 'OVERSEAS',
          {}, // userParams
          effectiveSettings.signalThreshold,
          effectiveSettings.weakSignalThreshold,
        );

        // 분석가/현재가 정보를 시그널에 기록
        signal.analysisPrice = analysisPrice;
        signal.currentPrice = currentPrice;
        signal.priceGapPercent = priceGapPercent;
        signal.currentPriceTimestamp = currentPriceTimestamp;
        signal.dataSource = priceDataSource;

        // ── 가격 anomaly 검증 (해외: analysisPrice vs currentPrice 괴리 20% 이상) ──
        const overseasAnomaly = checkPriceAnomaly(
          analysisPrice,
          currentPrice,
          stock.code,
          stock.name,
        );
        signal.priceAnomaly = overseasAnomaly.priceAnomaly;
        signal.anomalyReason = overseasAnomaly.anomalyReason;
        signal.anomalyCheckedAt = overseasAnomaly.anomalyCheckedAt;
        if (overseasAnomaly.priceAnomaly) {
          addLog('RISK', 'OVERSEAS',
            `⚠️ 가격 anomaly: ${stock.name} 분석가=${analysisPrice} vs 실시간=${currentPrice} (괴리 ${(overseasAnomaly.gapPercent * 100).toFixed(2)}%) — 신규 주문 및 자동 청산 차단`,
            {
              originalStockCode: currentPriceInfo?.originalStockCode || stock.code,
              stockCode: currentPriceInfo?.stockCode || stock.code,
              exchangeCode: normExchange,
              normalizedSymbol,
              analysisPrice,
              currentPrice,
              gapPercent: overseasAnomaly.gapPercent,
              anomalyReason: overseasAnomaly.anomalyReason,
              threshold: PRICE_ANOMALY_THRESHOLD,
              hint: '해외 일봉/현재가 단위 불일치 가능성 — /api/price/diagnostics?code=' + encodeURIComponent(stock.code) + ' 로 확인',
            }
          );
        }

        const gapDisplay = currentPrice > 0
          ? `, currentPrice=${currentPrice}, gap=${(priceGapPercent * 100).toFixed(2)}%`
          : '';

        // 해외 종목 분석 로그 (HOLD인 경우 holdReason 포함)
        if (signal.signalType === 'HOLD' && signal.holdReason) {
          addLog('INFO', 'OVERSEAS',
            `${stock.name} 분석 결과: HOLD (buyScore=${signal.buyScore ?? '-'}, sellScore=${signal.sellScore ?? '-'}, 임계값=${signal.finalThreshold ?? effectiveSettings.signalThreshold}) — ${signal.holdReason}`,
            {
              originalStockCode: currentPriceInfo?.originalStockCode || stock.code,
              stockCode: currentPriceInfo?.stockCode || stock.code,
              exchangeCode: normExchange,
              normalizedSymbol,
              candlesLength: candles.length,
              lastDailyClose: analysisPrice,
              currentPrice,
              priceGapPercent: parseFloat((priceGapPercent * 100).toFixed(4)),
              currentPriceTimestamp,
              dataSource: priceDataSource,
              signalType: signal.signalType,
              strategy: signal.strategy,
              holdReason: signal.holdReason,
            }
          );
        } else {
          addLog('INFO', 'OVERSEAS',
            `${stock.name} 분석 결과: ${signal.signalType} (신뢰도: ${signal.confidence}%), normalizedSymbol=${normalizedSymbol}, candles=${candles.length}, lastDailyClose=${analysisPrice}${gapDisplay}, source=${priceDataSource}`,
            {
              originalStockCode: currentPriceInfo?.originalStockCode || stock.code,
              stockCode: currentPriceInfo?.stockCode || stock.code,
              exchangeCode: normExchange,
              normalizedSymbol,
              candlesLength: candles.length,
              lastDailyClose: analysisPrice,
              currentPrice,
              priceGapPercent: parseFloat((priceGapPercent * 100).toFixed(4)),
              currentPriceTimestamp,
              rawPriceFields: currentPriceInfo?.rawPriceFields,
              currentPriceField: currentPriceInfo?.currentPriceField || 'last',
              dataSource: priceDataSource,
              realtimeEnabled: false,
              signalType: signal.signalType,
              strategy: signal.strategy,
            }
          );
        }

        // 상위 후보 추적 (BUY/SELL + HOLD 중 buyScore가 높은 것)
        topBuyCandidates.push({
          stockCode: stock.code,
          stockName: stock.name,
          confidence: signal.confidence,
          signalType: signal.signalType,
          buyScore: signal.buyScore,
          sellScore: signal.sellScore,
          finalThreshold: signal.finalThreshold ?? effectiveSettings.signalThreshold,
          holdReason: signal.holdReason,
        });

        if (signal.signalType !== 'HOLD') {
          signalsGenerated++;
          addLog('SIGNAL', 'OVERSEAS',
            `${stock.name} ${signal.signalType} 신호 (신뢰도: ${signal.confidence}%) - ${signal.reason}`,
            { signalType: signal.signalType, confidence: signal.confidence, price: signal.price, strategy: signal.strategy }
          );

          // AI 분석으로 신호 검증
          let finalSignal = signal;
          try {
            const aiResult = await aiAnalyzer.analyzeStock(
              stock.name, stock.code, 'OVERSEAS', signal
            );
            if (aiResult.confidence > 0) {
              finalSignal = aiAnalyzer.combineSignals(signal, aiResult);
              addLog('SIGNAL', 'OVERSEAS',
                `${stock.name} AI 검증: ${signal.signalType}→${finalSignal.signalType} (신뢰도: ${signal.confidence}%→${finalSignal.confidence}%) - AI심리: ${aiResult.sentiment}`,
                { aiRecommendation: aiResult.recommendation, aiConfidence: aiResult.confidence, aiRiskLevel: aiResult.riskLevel }
              );
            }
          } catch (aiError) {
            addLog('INFO', 'OVERSEAS', `${stock.name} AI 분석 스킵 (기술적 신호만 사용)`);
          }

          if (finalSignal.signalType === 'HOLD') {
            addLog('RISK', 'OVERSEAS', `${stock.name} AI 검증 결과 HOLD로 변경 - 매매 차단`);
            continue;
          }

          // ── priceAnomaly=true인 경우 해외 신규 주문 차단 ──
          if (finalSignal.priceAnomaly) {
            signalsBlockedReasons.push(`${stock.name}: 가격 anomaly (괴리 ${((finalSignal.priceGapPercent ?? 0) * 100).toFixed(2)}%)`);
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: ${stock.name} 가격 anomaly — 분석가 ${finalSignal.analysisPrice} vs 실시간 ${finalSignal.currentPrice}`,
              {
                stockCode: stock.code,
                signalType: finalSignal.signalType,
                analysisPrice: finalSignal.analysisPrice,
                currentPrice: finalSignal.currentPrice,
                gapPercent: finalSignal.priceGapPercent,
                anomalyReason: finalSignal.anomalyReason,
                blockedBy: 'PRICE_ANOMALY',
              }
            );
            continue;
          }

          // 해외 주문 OFF → 신호 생성만, 주문 차단
          if (!effectiveSettings.enableOverseasOrder) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: enableOverseasOrder=false`,
              { stockCode: stock.code, signalType: finalSignal.signalType, price: finalSignal.price }
            );
            continue;
          }

          // ── 해외 가격 괴리율 안전장치 ──
          const maxGap = effectiveSettings.maxOverseasPriceGapPercent;

          // (A) currentPrice <= 0 → 주문 차단
          if (currentPrice <= 0) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: 현재가 조회 불가 (currentPrice=${currentPrice})`,
              { stockCode: stock.code, signalType: finalSignal.signalType }
            );
            continue;
          }

          // (B) analysisPrice <= 0 → 주문 차단
          if (analysisPrice <= 0) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: 분석 기준가 불가 (analysisPrice=${analysisPrice})`,
              { stockCode: stock.code, signalType: finalSignal.signalType }
            );
            continue;
          }

          // (C) 괴리율 초과 → 주문 차단
          if (priceGapPercent > maxGap) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: 분석가와 현재가 괴리율 초과 (gap=${(priceGapPercent * 100).toFixed(2)}% > max=${(maxGap * 100).toFixed(2)}%)`,
              {
                stockCode: stock.code,
                signalType: finalSignal.signalType,
                analysisPrice,
                currentPrice,
                priceGapPercent: parseFloat((priceGapPercent * 100).toFixed(4)),
                maxOverseasPriceGapPercent: maxGap,
              }
            );
            continue;
          }

          // ── 주문 직전 현재가 재조회 ──
          // enableOverseasOrder=true일 때 주문 직전에 최신 가격으로 재검증
          let orderPrice = currentPrice; // 기본: 분석 시점 현재가
          try {
            const recheckPrice = await kisClient!.getOverseasCurrentPrice(stock.code, stock.exchange);
            const recheckCurrentPrice = recheckPrice.currentPrice;
            const recheckTimestamp = recheckPrice.timestamp;

            if (recheckCurrentPrice <= 0) {
              addLog('RISK', 'OVERSEAS',
                `해외 주문 차단: 주문 직전 현재가 재조회 실패 (currentPrice=${recheckCurrentPrice})`,
                { stockCode: stock.code, signalType: finalSignal.signalType }
              );
              continue;
            }

            // 재조회 가격으로 괴리율 재계산
            const recheckGap = analysisPrice > 0
              ? Math.abs(recheckCurrentPrice - analysisPrice) / analysisPrice
              : 1;

            if (recheckGap > maxGap) {
              addLog('RISK', 'OVERSEAS',
                `해외 주문 차단: 주문 직전 괴리율 초과 (gap=${(recheckGap * 100).toFixed(2)}% > max=${(maxGap * 100).toFixed(2)}%)`,
                {
                  stockCode: stock.code,
                  signalType: finalSignal.signalType,
                  analysisPrice,
                  currentPrice: recheckCurrentPrice,
                  priceGapPercent: parseFloat((recheckGap * 100).toFixed(4)),
                  recheckTimestamp,
                }
              );
              continue;
            }

            orderPrice = recheckCurrentPrice;
            addLog('INFO', 'OVERSEAS',
              `${stock.name} 주문 직전 현재가 재조회: $${recheckCurrentPrice} (gap=${(recheckGap * 100).toFixed(2)}%)`,
              { stockCode: stock.code, currentPrice: recheckCurrentPrice, analysisPrice, recheckGap, recheckTimestamp }
            );
          } catch (recheckError) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: 주문 직전 현재가 재조회 실패`,
              { stockCode: stock.code, error: recheckError instanceof Error ? recheckError.message : 'Unknown' }
            );
            continue;
          }

          // 리스크 체크 (currentPrice 기준)
          const riskSignal = { ...finalSignal, price: orderPrice };
          const riskCheck = overseasRisk.canTrade(
            riskSignal, overseasPositions.positions, overseasPositions.accountBalance
          );

          if (riskCheck.allowed) {
            // 주문 수량은 현재가 기준으로 재계산 (일봉 종가/signal.price 사용 금지)
            const quantity = overseasRisk.calculatePositionSize(
              overseasPositions.accountBalance, orderPrice, finalSignal.confidence
            );

            if (quantity <= 0) {
              addLog('RISK', 'OVERSEAS',
                `해외 주문 차단: 수량 계산 결과 0 이하 (price=$${orderPrice}, balance=${overseasPositions.accountBalance})`,
                { stockCode: stock.code, orderPrice, accountBalance: overseasPositions.accountBalance }
              );
              continue;
            }

            const result = await executeOrder(kisClient, { ...finalSignal, price: orderPrice }, 'OVERSEAS', effectiveSettings, stock.exchange, quantity);

            if (result.success) {
              ordersPlaced++;
              addLog('TRADE', 'OVERSEAS',
                `${stock.name} ${finalSignal.signalType} 주문 접수: ${quantity}주 @ $${orderPrice} (${result.orderNo})`,
                { orderNo: result.orderNo, quantity, price: orderPrice, exchange: stock.exchange, analysisPrice, currentPrice: orderPrice }
              );
            } else {
              addLog('ERROR', 'OVERSEAS',
                `${stock.name} ${finalSignal.signalType} 주문 실패: ${result.message}`,
                { orderNo: result.orderNo, quantity, price: orderPrice, exchange: stock.exchange }
              );
            }
          } else {
            addLog('RISK', 'OVERSEAS',
              `${stock.name} 매매 차단: ${riskCheck.reason}`,
              { reason: riskCheck.reason }
            );
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        errors.push(`해외 ${stock.name}: ${errMsg}`);
        overseasFailed++;
        addLog('ERROR', 'OVERSEAS', `${stock.name} 분석 오류: ${errMsg}`);
      }
    }

    addLog('INFO', 'OVERSEAS', `해외 분석 결과: 성공 ${overseasSuccess}종목, 실패 ${overseasFailed}종목`, {
      overseasSuccess,
      overseasFailed,
    });
  } else {
    addLog('INFO', 'OVERSEAS', '해외주식 분석 건너뜀 (enableOverseasAnalysis=false, 신호 생성만 수행 안 함)');
  }

  // ========================================
  // 포지션 동기화 (Reconciliation)
  // ========================================
  if (kisClient) {
    addLog('INFO', 'DOMESTIC', '포지션 동기화 시작 (잔고 기준)');
    await reconcilePositions(kisClient, 'DOMESTIC');
    if (effectiveSettings.enableOverseasAnalysis) {
      await reconcilePositions(kisClient, 'OVERSEAS');
    }
  }

  // ========================================
  // 포지션 모니토링 (손절/익절/트레일링스톱)
  // ========================================
  addLog('INFO', 'DOMESTIC', '포지션 모니터링 시작');
  
  const domesticExits = await monitorPositions(kisClient, 'DOMESTIC', effectiveSettings);
  const overseasExits = effectiveSettings.enableOverseasAnalysis ? await monitorPositions(kisClient, 'OVERSEAS', effectiveSettings) : 0;
  exitsExecuted = domesticExits + overseasExits;
  positionsMonitored = domesticPositions.positions.length + (effectiveSettings.enableOverseasAnalysis ? (await fetchPositions(kisClient, 'OVERSEAS')).positions.length : 0);

  // ========================================
  // 세션 업데이트
  // ========================================
  if (agentState.currentSessionId) {
    try {
      const session = await db.tradingSession.findUnique({
        where: { id: agentState.currentSessionId },
      });
      if (session) {
        await db.tradingSession.update({
          where: { id: agentState.currentSessionId },
          data: {
            totalTrades: session.totalTrades + ordersPlaced,
            updatedAt: new Date(),
          },
        });
      }
    } catch (e) {
      // 세션 업데이트 실패는 무시
    }
  }

  // stocksAnalyzed가 0이면 원인 진단
  let zeroAnalysisReason: string | undefined;
  if (stocksAnalyzed === 0) {
    zeroAnalysisReason = diagnoseZeroAnalysis(
      kisConfig, kisClient,
      domesticStocks.length, overseasStocks.length,
      domesticSuccess, domesticFailed,
      candleErrors
    );
    addLog('INFO', 'DOMESTIC', `분석된 종목 없음 - 원인: ${zeroAnalysisReason}`);
  }

  // 결과 정리
  const endTime = new Date();
  const result: AgentCycleResult = {
    success: errors.length === 0,
    startTime,
    endTime,
    stocksAnalyzed,
    signalsGenerated,
    ordersPlaced,
    positionsMonitored,
    exitsExecuted,
    logs: [...agentState.logs].slice(0, 50), // 최근 50개
    errors,
    domesticSuccess,
    domesticFailed,
    overseasSuccess,
    overseasFailed,
    zeroAnalysisReason,
    // ── 진단 필드 ──
    uiSignalsCount,
    executableSignalsCount,
    signalsBlockedReasons: signalsBlockedReasons.slice(0, 10),
    topBuyCandidates: topBuyCandidates
      .sort((a, b) => (b.buyScore ?? 0) - (a.buyScore ?? 0))  // buyScore 높은 순 정렬
      .slice(0, 5),
    signalThreshold: effectiveSettings.signalThreshold,
    weakSignalThreshold: effectiveSettings.weakSignalThreshold,
    minConfidenceThreshold: effectiveSettings.minConfidenceThreshold,
    strategyAggressiveness: effectiveSettings.strategyAggressiveness,
    positionQueryFailed,
    positionQueryFailedReason,
    forceTestSignalUsed,
  };

  agentState.lastCycleTime = endTime;
  agentState.lastCycleResult = result;
  agentState.totalCycles++;
  agentState.totalTrades += ordersPlaced;

  addLog('INFO', 'DOMESTIC', 
    `에이전트 사이클 완료: 분석 ${stocksAnalyzed}종목 (국내 성공 ${domesticSuccess}/실패 ${domesticFailed}), 신호 ${signalsGenerated}개, 주문 접수 ${ordersPlaced}건, 청산 ${exitsExecuted}건`
  );

  return result;
}

/**
 * 에이전트 시작
 */
export async function startAgent(): Promise<{ success: boolean; sessionId: string; message: string }> {
  if (agentState.isRunning) {
    return { success: false, sessionId: '', message: '이미 실행 중입니다.' };
  }

  try {
    // 기존 실행 중 세션 정지
    await db.tradingSession.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'STOPPED', stoppedAt: new Date() },
    });

    // 새 세션 생성
    const session = await db.tradingSession.create({
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    agentState.isRunning = true;
    agentState.currentSessionId = session.id;

    addLog('INFO', 'DOMESTIC', `자동매매 에이전트 시작 (세션: ${session.id})`);

    return { success: true, sessionId: session.id, message: '자동매매 에이전트가 시작되었습니다.' };
  } catch (error) {
    return { 
      success: false, 
      sessionId: '', 
      message: `시작 실패: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}

/**
 * 에이전트 중지
 */
export async function stopAgent(): Promise<{ success: boolean; message: string }> {
  if (!agentState.isRunning) {
    return { success: false, message: '실행 중이 아닙니다.' };
  }

  try {
    if (agentState.currentSessionId) {
      await db.tradingSession.update({
        where: { id: agentState.currentSessionId },
        data: { status: 'STOPPED', stoppedAt: new Date() },
      });
    }

    agentState.isRunning = false;
    agentState.currentSessionId = null;

    addLog('INFO', 'DOMESTIC', '자동매매 에이전트 중지');

    return { success: true, message: '자동매매 에이전트가 중지되었습니다.' };
  } catch (error) {
    return { 
      success: false, 
      message: `중지 실패: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}

/**
 * 에이전트 상태 조회
 */
export function getAgentStatus(): AgentStatus {
  return { ...agentState };
}

/**
 * 에이전트 로그 조회
 */
export function getAgentLogs(limit: number = 50): AgentLog[] {
  return agentState.logs.slice(0, limit);
}
