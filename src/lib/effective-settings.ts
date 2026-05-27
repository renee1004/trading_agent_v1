// 실제 실행 설정 공통 로드 함수
// 우선순위: DB AppSetting(trading_settings) > 환경변수 > 안전 기본값
// 위험 옵션(enableOverseasOrder, allowAfterHoursTrading)은
// 환경변수 OR DB에서 명시적 true여야 활성화 (둘 다 아니면 false)
//
// 모든 모듈(에이전트, 스케줄러, 리스크매니저, 상태 API)이
// 이 함수를 통해 동일한 설정을 읽도록 보장

import { db } from './db';
import { RiskConfig } from './types';
import { getMarketRiskConfig } from './market-defaults';
import { isMarketHours, getDomesticSession } from './agent-scheduler';
import { isOverseasMarketOpen, getOverseasBlockedReason } from './market-hours';

// =============================================
// 설정 인터페이스 + 안전 기본값
// =============================================
export type StrategyAggressiveness = 'CONSERVATIVE' | 'TEST' | 'AGGRESSIVE';

/**
 * strategyAggressiveness에 따른 임계값 매핑
 * - CONSERVATIVE: 기존 보수 기준 (신호 점수 ≥ 60 강매수, ≥ 40 약매수, 신뢰도 ≥ 50)
 * - TEST: 모의투자 파이프라인 검증용 (신호 점수 ≥ 30, 신뢰도 ≥ 30)
 * - AGGRESSIVE: 공격적 (신호 점수 ≥ 25, 신뢰도 ≥ 25)
 *
 * LIVE/REAL 모드에서는 항상 CONSERVATIVE 강제
 */
export const AGGRESSIVENESS_THRESHOLDS: Record<StrategyAggressiveness, {
  signalThreshold: number;       // TradingEngine BUY 신호 최소 buyScore
  weakSignalThreshold: number;   // 약한 BUY 신호 최소 buyScore
  minConfidence: number;         // RiskManager 최소 신뢰도(%)
}> = {
  CONSERVATIVE: {
    signalThreshold: 60,
    weakSignalThreshold: 40,
    minConfidence: 50,
  },
  TEST: {
    signalThreshold: 30,
    weakSignalThreshold: 25,
    minConfidence: 30,
  },
  AGGRESSIVE: {
    signalThreshold: 25,
    weakSignalThreshold: 20,
    minConfidence: 25,
  },
};

export interface EffectiveTradingSettings {
  // 자동 분석/주문 제어
  autoAnalysisEnabled: boolean;                 // 기본 true — 분석 사이클 자동 실행
  runAnalysisOnlyDuringMarketHours: boolean;     // 기본 false — true면 장시간에만 분석
  autoDomesticOrderEnabled: boolean;             // 기본 true(demo)/false(real) — 국내 자동 주문
  // 해외
  enableOverseasAnalysis: boolean;
  enableOverseasOrder: boolean;
  // 주문 정책
  allowAfterHoursTrading: boolean;
  tradeOnlyMarketHours: boolean;                // 주문을 장시간에만 허용
  // 스케줄러
  cycleIntervalMs: number;
  domesticMarketOpen: string;
  domesticMarketClose: string;
  overseasMarketOpen: string;
  overseasMarketClose: string;
  // 리스크
  maxPositionSize: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  maxOpenPositions: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  selectedStrategy: string;
  // 해외 가격 괴리율 안전장치
  maxOverseasPriceGapPercent: number;  // 분석가 vs 현재가 최대 허용 괴리율 (기본 0.5%)

  // ── 주문 실행 모드 ──
  tradingMode: 'DEMO' | 'REAL';                          // 기본 DEMO — KIS 계정 모드
  orderExecutionMode: 'DRY_RUN' | 'PAPER' | 'LIVE';      // 기본 DRY_RUN
  allowRealDomesticOrder: boolean;                        // 기본 false — 실전 국내 주문 허용
  allowRealOverseasOrder: boolean;                        // 기본 false — 실전 해외 주문 허용
  killSwitchEnabled: boolean;                             // 기본 false — true면 모든 주문 차단
  maxDomesticOrderAmount: number;                         // 국내 1회 최대 주문금액 (KRW)
  maxOverseasOrderAmount: number;                         // 해외 1회 최대 주문금액 (USD)
  maxDailyDomesticOrders: number;                         // 국내 일일 최대 주문 건수
  maxDailyOverseasOrders: number;                         // 해외 일일 최대 주문 건수
  maxOpenDomesticPositions: number;                       // 국내 최대 보유 포지션 수
  maxOpenOverseasPositions: number;                       // 해외 최대 보유 포지션 수

  // ── 전략 공격성 설정 ──
  strategyAggressiveness: StrategyAggressiveness;          // 기본 CONSERVATIVE
  // 런타임 계산값 (getEffectiveTradingSettings에서 자동 설정)
  signalThreshold: number;           // BUY 신호 최소 buyScore
  weakSignalThreshold: number;       // 약한 BUY 신호 최소 buyScore
  minConfidenceThreshold: number;    // RiskManager 최소 신뢰도(%)
}

const DEFAULT_SETTINGS: EffectiveTradingSettings = {
  autoAnalysisEnabled: true,
  runAnalysisOnlyDuringMarketHours: false,
  autoDomesticOrderEnabled: true,
  enableOverseasAnalysis: false,
  enableOverseasOrder: false,
  allowAfterHoursTrading: false,
  tradeOnlyMarketHours: true,
  cycleIntervalMs: 60000,
  domesticMarketOpen: '09:00',
  domesticMarketClose: '15:30',
  overseasMarketOpen: '23:30',
  overseasMarketClose: '06:00',
  maxPositionSize: 0.1,
  maxDailyLoss: 0.03,
  maxTotalLoss: 0.1,
  maxOpenPositions: 5,
  stopLossPercent: 0.05,
  takeProfitPercent: 0.15,
  trailingStopPercent: 0.03,
  selectedStrategy: 'COMPOSITE',
  maxOverseasPriceGapPercent: 0.005,  // 0.5% — 분석가와 현재가 괴리가 이 이상이면 해외 주문 차단

  // 주문 실행 모드 기본값 (모두 보수적)
  tradingMode: 'DEMO',
  orderExecutionMode: 'DRY_RUN',
  allowRealDomesticOrder: false,
  allowRealOverseasOrder: false,
  killSwitchEnabled: false,
  maxDomesticOrderAmount: 100000,    // KRW 10만원
  maxOverseasOrderAmount: 100,       // USD 100달러
  maxDailyDomesticOrders: 1,
  maxDailyOverseasOrders: 1,
  maxOpenDomesticPositions: 1,
  maxOpenOverseasPositions: 1,

  // 전략 공격성 기본값
  strategyAggressiveness: 'CONSERVATIVE',
  signalThreshold: AGGRESSIVENESS_THRESHOLDS.CONSERVATIVE.signalThreshold,
  weakSignalThreshold: AGGRESSIVENESS_THRESHOLDS.CONSERVATIVE.weakSignalThreshold,
  minConfidenceThreshold: AGGRESSIVENESS_THRESHOLDS.CONSERVATIVE.minConfidence,
};

export interface EffectiveSettingsResult {
  settings: EffectiveTradingSettings;
  source: 'db' | 'env' | 'default';
  sources: Record<string, 'db' | 'env' | 'default'>;
}

// =============================================
// Runtime Decision — 현재 시각 기준 즉시 판단
// =============================================
export interface RuntimeDecision {
  canRunAnalysisNow: boolean;
  canPlaceDomesticOrderNow: boolean;
  canPlaceOverseasOrderNow: boolean;
  analysisBlockedReason: string;
  domesticOrderBlockedReason: string;
  overseasOrderBlockedReason: string;
}

/**
 * 현재 시각과 설정을 기준으로 즉시 판단
 * /api/agent/status와 에이전트 로그에서 공통 사용
 */
export function computeRuntimeDecision(settings: EffectiveTradingSettings): RuntimeDecision {
  const domesticSession = getDomesticSession();
  const isDomesticOpen = domesticSession.session === 'REGULAR';
  const isOverseasOpen = isOverseasMarketOpen(); // ET 기준 (KST 요일 아님)

  // ── canRunAnalysisNow ──
  let canRunAnalysisNow = true;
  let analysisBlockedReason = '';
  if (!settings.autoAnalysisEnabled) {
    canRunAnalysisNow = false;
    analysisBlockedReason = 'autoAnalysisEnabled=false';
  } else if (settings.runAnalysisOnlyDuringMarketHours && !isDomesticOpen && !isOverseasOpen) {
    canRunAnalysisNow = false;
    analysisBlockedReason = 'runAnalysisOnlyDuringMarketHours=true + 장외/주말';
  }

  // ── canPlaceDomesticOrderNow ──
  let canPlaceDomesticOrderNow = true;
  let domesticOrderBlockedReason = '';
  if (!settings.autoDomesticOrderEnabled) {
    canPlaceDomesticOrderNow = false;
    domesticOrderBlockedReason = 'autoDomesticOrderEnabled=false';
  } else if (settings.tradeOnlyMarketHours && !isDomesticOpen) {
    canPlaceDomesticOrderNow = false;
    domesticOrderBlockedReason = `장외/주말 (${domesticSession.label})`;
  }

  // ── canPlaceOverseasOrderNow ──
  // 해외 주문은 ET 기준으로 장시간 판단 (KST 요일이 아닌 ET 요일)
  let canPlaceOverseasOrderNow = true;
  let overseasOrderBlockedReason = '';
  if (!settings.enableOverseasOrder) {
    canPlaceOverseasOrderNow = false;
    overseasOrderBlockedReason = 'enableOverseasOrder=false';
  } else if (settings.tradeOnlyMarketHours && !isOverseasOpen) {
    overseasOrderBlockedReason = getOverseasBlockedReason() || '해외 장시간 아님 (ET 기준)';
    canPlaceOverseasOrderNow = false;
  }

  return {
    canRunAnalysisNow,
    canPlaceDomesticOrderNow,
    canPlaceOverseasOrderNow,
    analysisBlockedReason,
    domesticOrderBlockedReason,
    overseasOrderBlockedReason,
  };
}

// =============================================
// DB > 환경변수 > 안전 기본값 설정 로드
// =============================================
export async function getEffectiveTradingSettings(): Promise<EffectiveSettingsResult> {
  let dbSettings: Record<string, unknown> | null = null;
  let hasDbSettings = false;

  // 1순위: DB AppSetting에서 조회
  try {
    const record = await db.appSetting.findUnique({
      where: { key: 'trading_settings' },
    });
    if (record?.value && typeof record.value === 'object') {
      dbSettings = record.value as Record<string, unknown>;
      hasDbSettings = true;
    }
  } catch (dbError) {
    console.warn('[EffectiveSettings] DB 조회 실패, 환경변수/기본값 사용:', dbError instanceof Error ? dbError.message : 'Unknown');
  }

  // 2순위: 환경변수에서 읽기
  const envValues: Partial<EffectiveTradingSettings> = {};
  if (process.env.ENABLE_OVERSEAS_TRADING === 'true') {
    envValues.enableOverseasAnalysis = true;
  }
  if (process.env.ENABLE_OVERSEAS_ANALYSIS === 'true') {
    envValues.enableOverseasAnalysis = true;
  }
  if (process.env.ENABLE_OVERSEAS_ORDER === 'true') {
    envValues.enableOverseasOrder = true;
  }
  if (process.env.ALLOW_AFTER_HOURS_TRADING === 'true') {
    envValues.allowAfterHoursTrading = true;
  }
  if (process.env.CYCLE_INTERVAL_MS) {
    const parsed = Number(process.env.CYCLE_INTERVAL_MS);
    if (Number.isFinite(parsed) && parsed >= 10000) {
      envValues.cycleIntervalMs = parsed;
    }
  }
  if (process.env.AUTO_ANALYSIS_ENABLED === 'false') {
    envValues.autoAnalysisEnabled = false;
  }
  if (process.env.AUTO_DOMESTIC_ORDER_ENABLED === 'true') {
    envValues.autoDomesticOrderEnabled = true;
  }
  if (process.env.AUTO_DOMESTIC_ORDER_ENABLED === 'false') {
    envValues.autoDomesticOrderEnabled = false;
  }

  // 최종 설정 병합: 기본값 < DB < 환경변수
  const settings: EffectiveTradingSettings = {
    ...DEFAULT_SETTINGS,
    ...(dbSettings || {}),
    ...envValues,
  };

  // =============================================
  // 위험 옵션 안전장치 (이중 게이트)
  // =============================================
  // enableOverseasOrder: DB true OR 환경변수 true → 활성화
  const dbEnableOrder = dbSettings?.enableOverseasOrder === true;
  const envEnableOrder = process.env.ENABLE_OVERSEAS_ORDER === 'true';
  settings.enableOverseasOrder = dbEnableOrder || envEnableOrder;

  // allowAfterHoursTrading: DB true OR 환경변수 true → 활성화
  const dbAllowAfterHours = dbSettings?.allowAfterHoursTrading === true;
  const envAllowAfterHours = process.env.ALLOW_AFTER_HOURS_TRADING === 'true';
  settings.allowAfterHoursTrading = dbAllowAfterHours || envAllowAfterHours;

  // enableOverseasAnalysis: DB true OR 환경변수
  const dbEnableAnalysis = dbSettings?.enableOverseasAnalysis === true;
  const envEnableAnalysis = process.env.ENABLE_OVERSEAS_ANALYSIS === 'true' || process.env.ENABLE_OVERSEAS_TRADING === 'true';
  settings.enableOverseasAnalysis = dbEnableAnalysis || envEnableAnalysis;

  // =============================================
  // autoDomesticOrderEnabled isDemo 안전장치
  // =============================================
  // 실전(isDemo=false)에서 DB에 명시적 true로 저장되지 않았으면 false
  // 모의(isDemo=true)에서는 기본 true
  try {
    const kisConfig = await db.kisConfig.findFirst();
    if (kisConfig && !kisConfig.isDemo) {
      // 실전: DB에 명시적으로 true가 아니면 false
      const dbAutoDomestic = dbSettings?.autoDomesticOrderEnabled === true;
      const envAutoDomestic = process.env.AUTO_DOMESTIC_ORDER_ENABLED === 'true';
      if (!dbAutoDomestic && !envAutoDomestic) {
        settings.autoDomesticOrderEnabled = false;
      }
    }
  } catch (_e) {
    // KIS 설정 조회 실패 시 기본값 유지
  }

  // =============================================
  // 주문 실행 모드 안전장치 (이중 게이트)
  // =============================================
  // allowRealDomesticOrder: DB true OR 환경변수 true → 활성화
  const dbAllowRealDomestic = dbSettings?.allowRealDomesticOrder === true;
  const envAllowRealDomestic = process.env.ALLOW_REAL_DOMESTIC_ORDER === 'true';
  settings.allowRealDomesticOrder = dbAllowRealDomestic || envAllowRealDomestic;

  // allowRealOverseasOrder: DB true OR 환경변수 true → 활성화
  const dbAllowRealOverseas = dbSettings?.allowRealOverseasOrder === true;
  const envAllowRealOverseas = process.env.ALLOW_REAL_OVERSEAS_ORDER === 'true';
  settings.allowRealOverseasOrder = dbAllowRealOverseas || envAllowRealOverseas;

  // killSwitchEnabled: DB true OR 환경변수 true → 활성화 (비상 정지)
  const dbKillSwitch = dbSettings?.killSwitchEnabled === true;
  const envKillSwitch = process.env.KILL_SWITCH_ENABLED === 'true';
  settings.killSwitchEnabled = dbKillSwitch || envKillSwitch;

  // orderExecutionMode: 열거형 유효성 검증
  const validModes = ['DRY_RUN', 'PAPER', 'LIVE'];
  if (!validModes.includes(settings.orderExecutionMode)) {
    settings.orderExecutionMode = 'DRY_RUN';
  }

  // tradingMode: 열거형 유효성 검증
  const validTradingModes = ['DEMO', 'REAL'];
  if (!validTradingModes.includes(settings.tradingMode)) {
    settings.tradingMode = 'DEMO';
  }

  // LIVE 모드에서 allowRealOrder가 모두 false면 DRY_RUN으로 강등
  if (settings.orderExecutionMode === 'LIVE' && !settings.allowRealDomesticOrder && !settings.allowRealOverseasOrder) {
    settings.orderExecutionMode = 'DRY_RUN';
  }

  // =============================================
  // 전략 공격성 + 임계값 설정
  // =============================================
  // strategyAggressiveness 유효성 검증
  const validAggressiveness: StrategyAggressiveness[] = ['CONSERVATIVE', 'TEST', 'AGGRESSIVE'];
  if (!validAggressiveness.includes(settings.strategyAggressiveness)) {
    settings.strategyAggressiveness = 'CONSERVATIVE';
  }

  // LIVE/REAL 모드에서는 항상 CONSERVATIVE 강제 (안전장치)
  const isLiveReal = settings.orderExecutionMode === 'LIVE' || settings.tradingMode === 'REAL';
  if (isLiveReal && settings.strategyAggressiveness !== 'CONSERVATIVE') {
    console.warn(`[EffectiveSettings] LIVE/REAL 모드에서는 CONSERVATIVE 강제 (원래=${settings.strategyAggressiveness})`);
    settings.strategyAggressiveness = 'CONSERVATIVE';
  }

  // strategyAggressiveness에 따른 임계값 자동 설정
  const thresholds = AGGRESSIVENESS_THRESHOLDS[settings.strategyAggressiveness];
  settings.signalThreshold = thresholds.signalThreshold;
  settings.weakSignalThreshold = thresholds.weakSignalThreshold;
  settings.minConfidenceThreshold = thresholds.minConfidence;

  // =============================================
  // 소스 추적
  // =============================================
  const source: 'db' | 'env' | 'default' = hasDbSettings
    ? 'db'
    : Object.keys(envValues).length > 0
      ? 'env'
      : 'default';

  const sources: Record<string, 'db' | 'env' | 'default'> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    // signalThreshold, weakSignalThreshold, minConfidenceThreshold은
    // strategyAggressiveness로부터 계산되므로, DB에 있더라도 'computed'로 표시
    // 하지만 sources 타입이 'db'|'env'|'default'이므로 'db'로 표시 (계산의 근원이 DB이므로)
    if (envValues[key as keyof EffectiveTradingSettings] !== undefined) {
      sources[key] = 'env';
    } else if (dbSettings?.[key] !== undefined) {
      sources[key] = 'db';
    } else if (
      (key === 'signalThreshold' || key === 'weakSignalThreshold' || key === 'minConfidenceThreshold') &&
      dbSettings?.strategyAggressiveness !== undefined
    ) {
      // 임계값 자체는 DB에 없어도, strategyAggressiveness가 DB에 있으면 'db'로 표시
      sources[key] = 'db';
    } else {
      sources[key] = 'default';
    }
  }

  return { settings, source, sources };
}

/**
 * DB 저장 리스크 설정을 RiskConfig로 변환
 */
export function buildRiskConfigFromSettings(
  settings: EffectiveTradingSettings,
  market: 'DOMESTIC' | 'OVERSEAS'
): RiskConfig {
  const marketDefaults = getMarketRiskConfig(market);
  return {
    maxPositionSize: settings.maxPositionSize ?? marketDefaults.maxPositionSize,
    maxDailyLoss: settings.maxDailyLoss ?? marketDefaults.maxDailyLoss,
    maxTotalLoss: settings.maxTotalLoss ?? marketDefaults.maxTotalLoss,
    maxOpenPositions: settings.maxOpenPositions ?? marketDefaults.maxOpenPositions,
    stopLossPercent: settings.stopLossPercent ?? marketDefaults.stopLossPercent,
    takeProfitPercent: settings.takeProfitPercent ?? marketDefaults.takeProfitPercent,
    trailingStopPercent: settings.trailingStopPercent ?? marketDefaults.trailingStopPercent,
  };
}

/**
 * 설정값 로그 출력 (민감정보 제외)
 */
export function formatSettingsSummary(settings: EffectiveTradingSettings): string {
  return [
    `autoAnalysis=${settings.autoAnalysisEnabled}`,
    `autoDomesticOrder=${settings.autoDomesticOrderEnabled}`,
    `overseasAnalysis=${settings.enableOverseasAnalysis}`,
    `overseasOrder=${settings.enableOverseasOrder}`,
    `afterHours=${settings.allowAfterHoursTrading}`,
    `tradeOnlyMarketHours=${settings.tradeOnlyMarketHours}`,
    `analysisMarketHoursOnly=${settings.runAnalysisOnlyDuringMarketHours}`,
    `cycleMs=${settings.cycleIntervalMs}`,
    `strategy=${settings.selectedStrategy}`,
    `mode=${settings.tradingMode}/${settings.orderExecutionMode}`,
    `aggressiveness=${settings.strategyAggressiveness}`,
    `signalThreshold=${settings.signalThreshold}`,
    `minConfidence=${settings.minConfidenceThreshold}`,
    `killSwitch=${settings.killSwitchEnabled}`,
    `allowRealDomestic=${settings.allowRealDomesticOrder}`,
    `allowRealOverseas=${settings.allowRealOverseasOrder}`,
  ].join(', ');
}

// =============================================
// 주문 실행 모드 검증
// =============================================
export interface OrderPreValidation {
  market: 'DOMESTIC' | 'OVERSEAS';
  tradingMode: 'DEMO' | 'REAL';
  orderExecutionMode: 'DRY_RUN' | 'PAPER' | 'LIVE';
  isDemo: boolean;
  enableOrder: boolean;           // autoDomesticOrderEnabled 또는 enableOverseasOrder
  allowRealOrder: boolean;        // allowRealDomesticOrder 또는 allowRealOverseasOrder
  killSwitchEnabled: boolean;
  currentPrice: number;
  currentPriceField: string;
  priceGapPercent: number;
  maxPriceGapPercent: number;
  availableAmount: number;
  calculatedQuantity: number;
  estimatedOrderAmount: number;
  maxOrderAmount: number;
  dailyOrderCount: number;
  maxDailyOrders: number;
  openPositions: number;
  maxOpenPositions: number;
  canPlaceOrder: boolean;
  blockedReason: string;
}

/**
 * 주문 실행 전 사전검증
 * killSwitch → orderExecutionMode → isDemo → allowRealOrder → 시장별 설정 → 금액/건수/포지션 한도
 */
export function validateOrderExecution(
  settings: EffectiveTradingSettings,
  market: 'DOMESTIC' | 'OVERSEAS',
  isDemo: boolean,
  signalPrice: number,
  quantity: number,
  availableAmount: number,
  dailyOrderCount: number,
  openPositions: number,
  currentPriceField?: string,
  priceGapPercent?: number,
): OrderPreValidation {
  const isDomestic = market === 'DOMESTIC';
  const enableOrder = isDomestic ? settings.autoDomesticOrderEnabled : settings.enableOverseasOrder;
  const allowRealOrder = isDomestic ? settings.allowRealDomesticOrder : settings.allowRealOverseasOrder;
  const maxOrderAmount = isDomestic ? settings.maxDomesticOrderAmount : settings.maxOverseasOrderAmount;
  const maxDailyOrders = isDomestic ? settings.maxDailyDomesticOrders : settings.maxDailyOverseasOrders;
  const maxPositions = isDomestic ? settings.maxOpenDomesticPositions : settings.maxOpenOverseasPositions;
  const estimatedOrderAmount = signalPrice * quantity;

  const result: OrderPreValidation = {
    market,
    tradingMode: settings.tradingMode,
    orderExecutionMode: settings.orderExecutionMode,
    isDemo,
    enableOrder,
    allowRealOrder,
    killSwitchEnabled: settings.killSwitchEnabled,
    currentPrice: signalPrice,
    currentPriceField: currentPriceField || 'last',
    priceGapPercent: priceGapPercent ?? 0,
    maxPriceGapPercent: settings.maxOverseasPriceGapPercent,
    availableAmount,
    calculatedQuantity: quantity,
    estimatedOrderAmount,
    maxOrderAmount,
    dailyOrderCount,
    maxDailyOrders,
    openPositions,
    maxOpenPositions: maxPositions,
    canPlaceOrder: false,
    blockedReason: '',
  };

  // 1. killSwitch — 모든 주문 차단
  if (settings.killSwitchEnabled) {
    result.blockedReason = 'killSwitchEnabled=true';
    return result;
  }

  // 2. DRY_RUN — 실제 주문 API 호출 금지
  if (settings.orderExecutionMode === 'DRY_RUN') {
    result.blockedReason = '주문 드라이런: 실제 주문 차단';
    return result;
  }

  // 3. PAPER — 모의투자 계정에서만 주문 허용
  if (settings.orderExecutionMode === 'PAPER' && !isDemo) {
    result.blockedReason = 'PAPER 모드는 모의투자 계정에서만 허용';
    return result;
  }

  // 4. LIVE — 실전 계정에서만 + allowRealOrder 필요
  if (settings.orderExecutionMode === 'LIVE') {
    if (isDemo) {
      result.blockedReason = 'LIVE 모드는 실전 계정에서만 허용';
      return result;
    }
    if (!allowRealOrder) {
      result.blockedReason = `실전 주문 차단: allowRealOrder=false`;
      return result;
    }
  }

  // 5. 시장별 주문 허용 체크
  if (!enableOrder) {
    result.blockedReason = isDomestic
      ? 'autoDomesticOrderEnabled=false'
      : 'enableOverseasOrder=false';
    return result;
  }

  // 6. 해외 추가 검증: currentPriceField, priceGapPercent
  if (!isDomestic) {
    if (currentPriceField !== 'last') {
      result.blockedReason = `해외 주문 차단: currentPriceField=${currentPriceField}`;
      return result;
    }
    if (signalPrice <= 0) {
      result.blockedReason = '해외 주문 차단: currentPrice <= 0';
      return result;
    }
    if ((priceGapPercent ?? 0) > settings.maxOverseasPriceGapPercent) {
      result.blockedReason = `해외 주문 차단: 괴리율 초과 (${((priceGapPercent ?? 0) * 100).toFixed(2)}% > ${(settings.maxOverseasPriceGapPercent * 100).toFixed(2)}%)`;
      return result;
    }
  }

  // 7. 주문금액 한도
  if (estimatedOrderAmount > maxOrderAmount) {
    result.blockedReason = `주문금액 초과: ${estimatedOrderAmount.toLocaleString()} > ${maxOrderAmount.toLocaleString()}`;
    return result;
  }

  // 8. 일일 주문 건수 한도
  if (dailyOrderCount >= maxDailyOrders) {
    result.blockedReason = `일일 주문 건수 초과: ${dailyOrderCount} >= ${maxDailyOrders}`;
    return result;
  }

  // 9. 보유 포지션 한도
  if (openPositions >= maxPositions) {
    result.blockedReason = `포지션 한도 초과: ${openPositions} >= ${maxPositions}`;
    return result;
  }

  // 10. 가용금액 부족 (PAPER/LIVE 모드에서만 — DRY_RUN은 이미 위에서 차단됨)
  if (availableAmount > 0 && estimatedOrderAmount > availableAmount) {
    result.blockedReason = `가용금액 부족: 주문금액 ${estimatedOrderAmount.toLocaleString()} > 가용금액 ${availableAmount.toLocaleString()}`;
    return result;
  }
  if (availableAmount <= 0 && (settings.orderExecutionMode as string) !== 'DRY_RUN') {
    // PAPER + DEMO 모드에서 잔고 조회 실패 시: 소액 주문은 허용 (파이프라인 검증 목적)
    // 주문금액이 maxOrderAmount 이하면 통과, 초과면 차단
    const isPaperDemo = settings.orderExecutionMode === 'PAPER' && isDemo;
    if (isPaperDemo && estimatedOrderAmount <= maxOrderAmount) {
      // PAPER 모의투자: 잔고 조회 실패해도 소액 주문 허용 (경고 로그만 남김)
      console.warn(`[OrderValidation] PAPER+DEMO 잔고 조회 실패 상태에서 소액 주문 허용 (주문금액=${estimatedOrderAmount}, 최대=${maxOrderAmount})`);
    } else {
      result.blockedReason = `가용금액 조회 불가 (availableAmount=0): 주문 차단`;
      return result;
    }
  }

  // 모든 검증 통과
  result.canPlaceOrder = true;
  return result;
}
