// POST /api/settings/trading/test-mode
// PAPER + 테스트 모드 전용 엔드포인트
// ── v4: Prisma upsert만 사용, override 키 최우선 저장 ──
// 핵심 변경: strategyAggressiveness를 별도 AppSetting 키에 먼저 저장
// 이후 메인 trading_settings에도 저장 (이중 보증)
// effective-settings는 override 키를 항상 최우선으로 읽음

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEffectiveTradingSettings } from '@/lib/effective-settings';

const SETTINGS_DB_KEY = 'trading_settings';
const OVERRIDE_KEY = 'strategy_aggressiveness_override';

/**
 * AppSetting에서 findUnique → findFirst 폴백으로 레코드 조회
 */
async function findAppSetting(key: string): Promise<{ value: unknown } | null> {
  try {
    let record = await db.appSetting.findUnique({ where: { key } });
    if (!record) {
      try { record = await db.appSetting.findFirst({ where: { key } }); } catch (_e) { /* ignore */ }
    }
    return record;
  } catch (_e) {
    return null;
  }
}

export async function POST() {
  try {
    console.log('[TestMode] ====== POST 시작 ======');

    // ═══════════════════════════════════════════════════════
    // STEP 1: override 키에 strategyAggressiveness='TEST' 저장 (최우선!)
    // 이것이 가장 중요한 단계입니다.
    // 메인 trading_settings의 Prisma Json 직렬화 버그와 무관하게
    // 별도 키에 확실하게 저장합니다.
    // ═══════════════════════════════════════════════════════
    let overrideSaved = false;
    try {
      await db.appSetting.upsert({
        where: { key: OVERRIDE_KEY },
        update: { value: { strategyAggressiveness: 'TEST' } },
        create: { key: OVERRIDE_KEY, value: { strategyAggressiveness: 'TEST' } },
      });
      overrideSaved = true;
      console.log('[TestMode] STEP 1 - override 키 저장 성공: strategyAggressiveness=TEST');
    } catch (e) {
      console.error('[TestMode] STEP 1 - override 키 저장 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // 검증: 방금 저장한 override 키 읽기
    let overrideVerified = false;
    try {
      const overrideRecord = await findAppSetting(OVERRIDE_KEY);
      if (overrideRecord?.value && typeof overrideRecord.value === 'object') {
        const val = (overrideRecord.value as Record<string, unknown>).strategyAggressiveness;
        overrideVerified = val === 'TEST';
        console.log('[TestMode] STEP 1 검증 - override 키 읽기:', { val, overrideVerified });
      }
    } catch (_e) { /* ignore */ }

    // ═══════════════════════════════════════════════════════
    // STEP 2: 메인 trading_settings에도 저장 (이중 보증)
    // ═══════════════════════════════════════════════════════
    // 기존 값 읽기
    let existingValue: Record<string, unknown> = {};
    try {
      const existing = await findAppSetting(SETTINGS_DB_KEY);
      if (existing?.value && typeof existing.value === 'object') {
        existingValue = existing.value as Record<string, unknown>;
      }
    } catch (_e) { /* ignore */ }

    // 병합: 기존값 + TEST 모드 오버라이드
    const mergedValue: Record<string, unknown> = {
      ...existingValue,
      tradingMode: 'DEMO',
      orderExecutionMode: 'PAPER',
      strategyAggressiveness: 'TEST',
      autoDomesticOrderEnabled: true,
      killSwitchEnabled: false,
      allowRealDomesticOrder: false,
      allowRealOverseasOrder: false,
    };

    // 계산값 제거 (strategyAggressiveness에서 자동 계산)
    delete mergedValue.signalThreshold;
    delete mergedValue.weakSignalThreshold;
    delete mergedValue.minConfidenceThreshold;

    // 3중 보증: strategyAggressiveness가 반드시 TEST
    if (mergedValue.strategyAggressiveness !== 'TEST') {
      console.error('[TestMode] BUG: 병합 후 strategyAggressiveness가 TEST가 아님!', mergedValue.strategyAggressiveness);
      mergedValue.strategyAggressiveness = 'TEST';
    }

    let mainSaved = false;
    try {
      await db.appSetting.upsert({
        where: { key: SETTINGS_DB_KEY },
        update: { value: mergedValue },
        create: { key: SETTINGS_DB_KEY, value: mergedValue },
      });
      mainSaved = true;
      console.log('[TestMode] STEP 2 - 메인 trading_settings 저장 성공');
    } catch (e) {
      console.error('[TestMode] STEP 2 - 메인 저장 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // ═══════════════════════════════════════════════════════
    // STEP 3: 검증 (최대 3회 재시도)
    // ═══════════════════════════════════════════════════════
    let mainVerified = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const record = await findAppSetting(SETTINGS_DB_KEY);
        if (record?.value && typeof record.value === 'object') {
          const val = (record.value as Record<string, unknown>).strategyAggressiveness;
          mainVerified = val === 'TEST';
          console.log(`[TestMode] STEP 3 - 검증 ${attempt}/3:`, { strategyAggressiveness: val, verified: mainVerified });
        }
        if (mainVerified) break;

        // 재시도: 다시 저장
        if (attempt < 3) {
          try {
            await db.appSetting.upsert({
              where: { key: SETTINGS_DB_KEY },
              update: { value: { ...mergedValue, strategyAggressiveness: 'TEST' } },
              create: { key: SETTINGS_DB_KEY, value: { ...mergedValue, strategyAggressiveness: 'TEST' } },
            });
          } catch (_e) { /* ignore */ }
        }
      } catch (_e) { /* ignore */ }
    }

    // ═══════════════════════════════════════════════════════
    // STEP 4: effectiveSettings 재계산 (최종 검증)
    // ═══════════════════════════════════════════════════════
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    const effectiveVerified = effectiveResult.strategyAggressiveness === 'TEST'
      && effectiveResult.orderExecutionMode === 'PAPER'
      && effectiveResult.signalThreshold === 30
      && effectiveResult.minConfidenceThreshold === 30;

    if (effectiveVerified) {
      console.log('[TestMode] STEP 4 - 전체 검증 성공 ✓');
    } else {
      console.error('[TestMode] STEP 4 - 검증 실패:', {
        strategyAggressiveness: effectiveResult.strategyAggressiveness,
        signalThreshold: effectiveResult.signalThreshold,
        minConfidenceThreshold: effectiveResult.minConfidenceThreshold,
        source: resultSource,
        sourcesStrategyAgg: resultSources.strategyAggressiveness,
        overrideSaved,
        overrideVerified,
        mainSaved,
        mainVerified,
      });
    }

    return NextResponse.json({
      success: true,
      data: effectiveResult,
      source: resultSource,
      sources: resultSources,
      verified: effectiveVerified,
      debug: {
        overrideSaved,
        overrideVerified,
        mainSaved,
        mainVerified,
        effectiveStrategyAggressiveness: effectiveResult.strategyAggressiveness,
        effectiveSignalThreshold: effectiveResult.signalThreshold,
        effectiveMinConfidence: effectiveResult.minConfidenceThreshold,
        sourcesStrategyAggressiveness: resultSources.strategyAggressiveness,
      },
      message: effectiveVerified
        ? 'TEST 모드 전환 완료 ✓ signalThreshold=30, minConfidence=30'
        : `검증 실패: aggressiveness=${effectiveResult.strategyAggressiveness}, threshold=${effectiveResult.signalThreshold}, source=${resultSources.strategyAggressiveness}`,
    });
  } catch (error) {
    console.error('[TestMode] 전체 오류:', error);
    return NextResponse.json(
      { success: false, error: `TEST 모드 전환 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

// GET: DB 진단
export async function GET() {
  try {
    // 1) override 키 조회
    let overrideValue: unknown = null;
    let overrideFound = false;
    try {
      const record = await findAppSetting(OVERRIDE_KEY);
      if (record?.value) {
        overrideValue = record.value;
        overrideFound = true;
      }
    } catch (_e) { /* ignore */ }

    // 2) 메인 trading_settings 조회
    let mainValue: unknown = null;
    let mainFound = false;
    try {
      const record = await findAppSetting(SETTINGS_DB_KEY);
      if (record?.value) {
        mainValue = record.value;
        mainFound = true;
      }
    } catch (_e) { /* ignore */ }

    // 3) effectiveSettings
    const { settings, source, sources } = await getEffectiveTradingSettings();

    // 4) DB 타입
    let dbType = 'Unknown';
    try {
      const { getDbType } = await import('@/lib/db');
      dbType = getDbType();
    } catch (_e) { /* ignore */ }

    return NextResponse.json({
      success: true,
      dbType,
      override: {
        found: overrideFound,
        strategyAggressiveness: (overrideValue as Record<string, unknown>)?.strategyAggressiveness ?? null,
        fullValue: overrideValue,
      },
      main: {
        found: mainFound,
        strategyAggressiveness: (mainValue as Record<string, unknown>)?.strategyAggressiveness ?? null,
        orderExecutionMode: (mainValue as Record<string, unknown>)?.orderExecutionMode ?? null,
        allKeys: mainValue && typeof mainValue === 'object' ? Object.keys(mainValue as Record<string, unknown>) : [],
      },
      effective: {
        strategyAggressiveness: settings.strategyAggressiveness,
        orderExecutionMode: settings.orderExecutionMode,
        signalThreshold: settings.signalThreshold,
        weakSignalThreshold: settings.weakSignalThreshold,
        minConfidenceThreshold: settings.minConfidenceThreshold,
      },
      source,
      sources: {
        strategyAggressiveness: sources.strategyAggressiveness,
        orderExecutionMode: sources.orderExecutionMode,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `진단 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
