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
  // 소스 추적
  // =============================================
  const source: 'db' | 'env' | 'default' = hasDbSettings
    ? 'db'
    : Object.keys(envValues).length > 0
      ? 'env'
      : 'default';

  const sources: Record<string, 'db' | 'env' | 'default'> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (envValues[key as keyof EffectiveTradingSettings] !== undefined) {
      sources[key] = 'env';
    } else if (dbSettings?.[key] !== undefined) {
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

  // 2. DRY_RUN — 모든 주문 API 호출 금지 (신호만 생성)
  if (settings.orderExecutionMode === 'DRY_RUN') {
    result.blockedReason = 'DRY_RUN 모드: 주문 API 호출 차단 (신호만 생성)';
    return result;
  }

  // 3. PAPER — 모의투자 계정(isDemo=true)에서만 주문 허용
  //    실전 계정에서 PAPER 선택 불가
  if (settings.orderExecutionMode === 'PAPER') {
    if (!isDemo) {
      result.blockedReason = 'PAPER 모드는 모의투자 계정(isDemo=true)에서만 허용 — 현재 실전 계정';
      return result;
    }
    // PAPER + DEMO + isDemo=true → 모의투자 주문 허용 (통과)
  }

  // 4. LIVE — 실전 주문: 현재 단계에서 하드 블록
  //    실전 주문은 LIVE_EXECUTE 모드 + 실전 키 + 명시적 허용 모두 필요
  if (settings.orderExecutionMode === 'LIVE') {
    if (isDemo) {
      result.blockedReason = 'LIVE 모드는 실전 계정에서만 허용 — 현재 모의투자 계정';
      return result;
    }
    if (!allowRealOrder) {
      result.blockedReason = '실전 주문 차단: allowRealOrder=false — 실전 주문을 허용하려면 명시적으로 true 설정 필요';
      return result;
    }
    // 추가 안전장치: tradingMode가 REAL이 아니면 실전 주문 차단
    if (settings.tradingMode !== 'REAL') {
      result.blockedReason = '실전 주문 차단: tradingMode=DEMO — 실전 주문은 tradingMode=REAL 필요';
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
  if (availableAmount <= 0 && settings.orderExecutionMode !== 'DRY_RUN') {
    result.blockedReason = `가용금액 조회 불가 (availableAmount=0): 주문 차단`;
    return result;
  }

  // 모든 검증 통과
  result.canPlaceOrder = true;
  return result;
}

/**
 * 모의투자 주문 활성화에 필요한 설정값 안내
 * 현재 설정 기준으로 모의투자 주문이 가능하려면 무엇을 변경해야 하는지 반환
 */
export function getDemoOrderActivationGuide(settings: EffectiveTradingSettings): {
  canSendDemoDomesticOrder: boolean;
  requiredSettings: string[];
  currentValues: Record<string, any>;
  currentBlockingReasons: string[];
  modeExplanation: string;
} {
  const requiredSettings = [
    'tradingMode=DEMO',
    'orderExecutionMode=PAPER',
    'autoDomesticOrderEnabled=true',
    'killSwitchEnabled=false',
    'isDemo=true (KIS 모의투자 계정)',
  ];

  const currentValues: Record<string, any> = {
    tradingMode: settings.tradingMode,
    orderExecutionMode: settings.orderExecutionMode,
    autoDomesticOrderEnabled: settings.autoDomesticOrderEnabled,
    killSwitchEnabled: settings.killSwitchEnabled,
    allowRealDomesticOrder: settings.allowRealDomesticOrder,
  };

  const currentBlockingReasons: string[] = [];

  if (settings.killSwitchEnabled) {
    currentBlockingReasons.push(`killSwitchEnabled=true — 모든 주문 차단`);
  }

  if (settings.orderExecutionMode === 'DRY_RUN') {
    currentBlockingReasons.push(`orderExecutionMode=DRY_RUN — 주문 API 호출 차단 (PAPER로 변경 필요)`);
  }

  if (settings.orderExecutionMode === 'LIVE') {
    currentBlockingReasons.push(`orderExecutionMode=LIVE — 실전 전용 모드 (PAPER로 변경 필요)`);
  }

  if (!settings.autoDomesticOrderEnabled) {
    currentBlockingReasons.push(`autoDomesticOrderEnabled=false — 국내 자동 주문 비활성화`);
  }

  const canSendDemoDomesticOrder = currentBlockingReasons.length === 0;

  const modeExplanation = [
    '■ 주문 실행 모드 설명:',
    '- DRY_RUN: 신호만 생성, KIS 주문 API 호출 안함 (현재 모드)',
    '- PAPER: 모의투자 계정(isDemo=true)에서 실제 주문 접수 — KIS 모의투자 서버로 주문 전송',
    '- LIVE: 실전 계정에서 실제 주문 — tradingMode=REAL + allowRealDomesticOrder=true 필요 (현재 차단)',
    '',
    '■ allowRealDomesticOrder 설명:',
    '- false (기본값): 실전 주문 차단 — PAPER 모드에서 모의투자 주문에는 영향 없음',
    '- true: 실전 주문 허용 — LIVE 모드 + 실전 계정에서만 의미 있음',
    '- 현재 모의투자 계정이므로 이 값이 false여도 PAPER 주문은 정상 작동',
  ].join('\n');

  return {
    canSendDemoDomesticOrder,
    requiredSettings,
    currentValues,
    currentBlockingReasons,
    modeExplanation,
  };
}
