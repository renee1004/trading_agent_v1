// POST /api/settings/trading/mode
// 전략 공격성 모드 전환 엔드포인트
// PIPELINE_TEST / STRATEGY_TEST / CONSERVATIVE / AGGRESSIVE_STRATEGY 간 전환
// 각 모드에 맞는 설정 자동 적용 (useATRStop, partialTakeProfit, indexFilter 등)

import { NextRequest, NextResponse } from 'next/server';
import { prisma, getAppSetting, setAppSetting, isPrismaAvailable, ensurePrismaConnected } from '@/lib/prisma';
import { getEffectiveTradingSettings, AGGRESSIVENESS_THRESHOLDS, type StrategyAggressiveness } from '@/lib/effective-settings';

const SETTINGS_DB_KEY = 'trading_settings';
const OVERRIDE_KEY = 'strategy_aggressiveness_override';

const VALID_MODES: StrategyAggressiveness[] = ['CONSERVATIVE', 'PIPELINE_TEST', 'STRATEGY_TEST', 'AGGRESSIVE_STRATEGY'];

// 모드별 기본 설정 프리셋
const MODE_PRESETS: Record<StrategyAggressiveness, Record<string, unknown>> = {
  CONSERVATIVE: {
    strategyAggressiveness: 'CONSERVATIVE',
    orderExecutionMode: 'DRY_RUN',
    tradingMode: 'DEMO',
    autoDomesticOrderEnabled: true,
    killSwitchEnabled: false,
    allowRealDomesticOrder: false,
    allowRealOverseasOrder: false,
  },
  PIPELINE_TEST: {
    strategyAggressiveness: 'PIPELINE_TEST',
    orderExecutionMode: 'PAPER',
    tradingMode: 'DEMO',
    autoDomesticOrderEnabled: true,
    killSwitchEnabled: false,
    allowRealDomesticOrder: false,
    allowRealOverseasOrder: false,
    maxDomesticOrderAmount: 500000,
    maxDailyDomesticOrders: 3,
  },
  STRATEGY_TEST: {
    strategyAggressiveness: 'STRATEGY_TEST',
    orderExecutionMode: 'PAPER',
    tradingMode: 'DEMO',
    autoDomesticOrderEnabled: true,
    killSwitchEnabled: false,
    allowRealDomesticOrder: false,
    allowRealOverseasOrder: false,
    maxDomesticOrderAmount: 500000,
    maxDailyDomesticOrders: 5,
    maxOpenDomesticPositions: 3,
  },
  AGGRESSIVE_STRATEGY: {
    strategyAggressiveness: 'AGGRESSIVE_STRATEGY',
    orderExecutionMode: 'PAPER',
    tradingMode: 'DEMO',
    autoDomesticOrderEnabled: true,
    killSwitchEnabled: false,
    allowRealDomesticOrder: false,
    allowRealOverseasOrder: false,
    maxDomesticOrderAmount: 1000000,
    maxDailyDomesticOrders: 5,
    maxOpenDomesticPositions: 5,
  },
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const requestedMode = body.mode as string;

    if (!requestedMode || !VALID_MODES.includes(requestedMode as StrategyAggressiveness)) {
      return NextResponse.json(
        { success: false, error: `유효하지 않은 모드: ${requestedMode}. 유효: ${VALID_MODES.join(', ')}` },
        { status: 400 }
      );
    }

    const mode = requestedMode as StrategyAggressiveness;
    const preset = MODE_PRESETS[mode];
    const thresholds = AGGRESSIVENESS_THRESHOLDS[mode];

    console.log(`[ModeSwitch] ====== ${mode} 모드 전환 시작 ======`);

    // Prisma 연결 보장
    await ensurePrismaConnected();

    // STEP 1: override 키에 모드 저장
    const overrideSaved = await setAppSetting(OVERRIDE_KEY, { strategyAggressiveness: mode });
    console.log(`[ModeSwitch] STEP 1 - override 키 저장:`, overrideSaved ? '성공' : '실패');

    // STEP 2: 메인 trading_settings에 프리셋 병합
    let existingValue: Record<string, unknown> = {};
    const existingRecord = await getAppSetting(SETTINGS_DB_KEY);
    if (existingRecord?.value && typeof existingRecord.value === 'object') {
      existingValue = existingRecord.value as Record<string, unknown>;
    }

    const mergedValue: Record<string, unknown> = {
      ...existingValue,
      ...preset,
    };

    // 계산값 제거 (effective-settings에서 자동 계산)
    delete mergedValue.signalThreshold;
    delete mergedValue.weakSignalThreshold;
    delete mergedValue.minConfidenceThreshold;
    delete mergedValue.accountRiskPercent;
    delete mergedValue.useATRStop;
    delete mergedValue.partialTakeProfit;
    delete mergedValue.indexFilter;

    // 최종 확인
    if (mergedValue.strategyAggressiveness !== mode) {
      console.error(`[ModeSwitch] BUG: 병합 후 모드가 ${mode}가 아님!`, mergedValue.strategyAggressiveness);
      mergedValue.strategyAggressiveness = mode;
    }

    const mainSaved = await setAppSetting(SETTINGS_DB_KEY, mergedValue);
    console.log(`[ModeSwitch] STEP 2 - 메인 설정 저장:`, mainSaved ? '성공' : '실패');

    // STEP 3: 검증 (최대 3회 재시도)
    let mainVerified = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const record = await getAppSetting(SETTINGS_DB_KEY);
      if (record?.value && typeof record.value === 'object') {
        const val = (record.value as Record<string, unknown>).strategyAggressiveness;
        mainVerified = val === mode;
        console.log(`[ModeSwitch] STEP 3 - 검증 ${attempt}/3:`, { strategyAggressiveness: val, verified: mainVerified });
      }
      if (mainVerified) break;
      if (attempt < 3) {
        await setAppSetting(SETTINGS_DB_KEY, { ...mergedValue, strategyAggressiveness: mode });
      }
    }

    // STEP 4: effectiveSettings 재계산
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    const effectiveVerified = effectiveResult.strategyAggressiveness === mode;

    const result = {
      success: true,
      mode,
      data: effectiveResult,
      source: resultSource,
      sources: resultSources,
      verified: effectiveVerified,
      thresholds: {
        signalThreshold: thresholds.signalThreshold,
        weakSignalThreshold: thresholds.weakSignalThreshold,
        minConfidence: thresholds.minConfidence,
        accountRiskPercent: thresholds.accountRiskPercent,
        useATRStop: thresholds.useATRStop,
        partialTakeProfit: thresholds.partialTakeProfit,
        indexFilter: thresholds.indexFilter,
      },
      debug: {
        prismaAvailable: isPrismaAvailable(),
        overrideSaved,
        mainSaved,
        mainVerified,
        effectiveStrategyAggressiveness: effectiveResult.strategyAggressiveness,
        effectiveSignalThreshold: effectiveResult.signalThreshold,
        effectiveUseATRStop: effectiveResult.useATRStop,
        effectivePartialTakeProfit: effectiveResult.partialTakeProfit,
        effectiveIndexFilter: effectiveResult.indexFilter,
      },
      message: effectiveVerified
        ? `${mode} 모드 전환 완료 ✓ signalThreshold=${thresholds.signalThreshold}, useATRStop=${thresholds.useATRStop}, partialTakeProfit=${thresholds.partialTakeProfit}, indexFilter=${thresholds.indexFilter}`
        : `검증 실패: aggressiveness=${effectiveResult.strategyAggressiveness}, source=${resultSources.strategyAggressiveness}`,
    };

    console.log(`[ModeSwitch] 결과:`, result.message);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[ModeSwitch] 전체 오류:', error);
    return NextResponse.json(
      { success: false, error: `모드 전환 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

// GET: 현재 모드 상태 조회
export async function GET() {
  try {
    await ensurePrismaConnected();
    const { settings, source, sources } = await getEffectiveTradingSettings();
    const currentMode = settings.strategyAggressiveness;
    const thresholds = AGGRESSIVENESS_THRESHOLDS[currentMode];

    return NextResponse.json({
      success: true,
      currentMode,
      thresholds: {
        signalThreshold: thresholds.signalThreshold,
        weakSignalThreshold: thresholds.weakSignalThreshold,
        minConfidence: thresholds.minConfidence,
        accountRiskPercent: thresholds.accountRiskPercent,
        useATRStop: thresholds.useATRStop,
        partialTakeProfit: thresholds.partialTakeProfit,
        indexFilter: thresholds.indexFilter,
        description: thresholds.description,
      },
      effectiveSettings: {
        strategyAggressiveness: settings.strategyAggressiveness,
        orderExecutionMode: settings.orderExecutionMode,
        tradingMode: settings.tradingMode,
        signalThreshold: settings.signalThreshold,
        weakSignalThreshold: settings.weakSignalThreshold,
        minConfidenceThreshold: settings.minConfidenceThreshold,
        accountRiskPercent: settings.accountRiskPercent,
        useATRStop: settings.useATRStop,
        partialTakeProfit: settings.partialTakeProfit,
        indexFilter: settings.indexFilter,
        maxDomesticOrderAmount: settings.maxDomesticOrderAmount,
        maxDailyDomesticOrders: settings.maxDailyDomesticOrders,
      },
      availableModes: VALID_MODES.map(m => ({
        value: m,
        label: AGGRESSIVENESS_THRESHOLDS[m].description,
        thresholds: AGGRESSIVENESS_THRESHOLDS[m],
      })),
      source,
      sources: {
        strategyAggressiveness: sources.strategyAggressiveness,
        orderExecutionMode: sources.orderExecutionMode,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `모드 상태 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
