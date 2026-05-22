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

// 안전 기본값 — 아무 설정도 없을 때의 값
export interface EffectiveTradingSettings {
  enableOverseasAnalysis: boolean;
  enableOverseasOrder: boolean;
  allowAfterHoursTrading: boolean;
  cycleIntervalMs: number;
  tradeOnlyMarketHours: boolean;
  domesticMarketOpen: string;
  domesticMarketClose: string;
  overseasMarketOpen: string;
  overseasMarketClose: string;
  maxPositionSize: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  maxOpenPositions: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  selectedStrategy: string;
}

const DEFAULT_SETTINGS: EffectiveTradingSettings = {
  enableOverseasAnalysis: false,
  enableOverseasOrder: false,
  allowAfterHoursTrading: false,
  cycleIntervalMs: 60000,
  tradeOnlyMarketHours: true,
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
};

export interface EffectiveSettingsResult {
  /** 최종 병합된 설정값 */
  settings: EffectiveTradingSettings;
  /** 전체 설정의 대표 소스 ('db' | 'env' | 'default') */
  source: 'db' | 'env' | 'default';
  /** 개별 필드별 소스 추적 */
  sources: Record<string, 'db' | 'env' | 'default'>;
}

/**
 * DB > 환경변수 > 안전 기본값 우선순위로 실제 실행 설정 반환
 *
 * 위험 옵션 안전장치:
 * - enableOverseasOrder: DB에서 true OR 환경변수에서 true일 때만 활성화
 * - allowAfterHoursTrading: DB에서 true OR 환경변수에서 true일 때만 활성화
 * - 둘 다 명시적 true가 아니면 항상 false
 *
 * 에이전트 실행, 스케줄러, 리스크매니저, 상태 API에서 공통 사용
 */
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
  // ENABLE_OVERSEAS_TRADING(레거시)이 true이면 분석도 활성화
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
  // 둘 다 명시적 true가 아니면 무조건 false
  const dbEnableOrder = dbSettings?.enableOverseasOrder === true;
  const envEnableOrder = process.env.ENABLE_OVERSEAS_ORDER === 'true';
  settings.enableOverseasOrder = dbEnableOrder || envEnableOrder;

  // allowAfterHoursTrading: DB true OR 환경변수 true → 활성화
  const dbAllowAfterHours = dbSettings?.allowAfterHoursTrading === true;
  const envAllowAfterHours = process.env.ALLOW_AFTER_HOURS_TRADING === 'true';
  settings.allowAfterHoursTrading = dbAllowAfterHours || envAllowAfterHours;

  // enableOverseasAnalysis: DB true OR (환경변수 ENABLE_OVERSEAS_ANALYSIS=true OR ENABLE_OVERSEAS_TRADING=true)
  const dbEnableAnalysis = dbSettings?.enableOverseasAnalysis === true;
  const envEnableAnalysis = process.env.ENABLE_OVERSEAS_ANALYSIS === 'true' || process.env.ENABLE_OVERSEAS_TRADING === 'true';
  settings.enableOverseasAnalysis = dbEnableAnalysis || envEnableAnalysis;

  // =============================================
  // 소스 추적
  // =============================================
  // 전체 대표 소스
  const source: 'db' | 'env' | 'default' = hasDbSettings
    ? 'db'
    : Object.keys(envValues).length > 0
      ? 'env'
      : 'default';

  // 개별 필드별 소스
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
 * DB에 없는 필드는 시장별 기본값(market-defaults) 사용
 *
 * 사용: runAgentCycle()에서 RiskManager 생성 시
 *   const riskConfig = buildRiskConfigFromSettings(settings, 'DOMESTIC');
 *   const riskManager = new RiskManager(riskConfig, 'DOMESTIC');
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
    `overseasAnalysis=${settings.enableOverseasAnalysis}`,
    `overseasOrder=${settings.enableOverseasOrder}`,
    `afterHours=${settings.allowAfterHoursTrading}`,
    `cycleMs=${settings.cycleIntervalMs}`,
    `marketHoursOnly=${settings.tradeOnlyMarketHours}`,
    `strategy=${settings.selectedStrategy}`,
    `maxPos=${settings.maxPositionSize}`,
    `stopLoss=${settings.stopLossPercent}`,
    `takeProfit=${settings.takeProfitPercent}`,
  ].join(', ');
}
