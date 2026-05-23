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
  ].join(', ');
}
