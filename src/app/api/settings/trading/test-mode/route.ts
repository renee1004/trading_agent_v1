// POST /api/settings/trading/test-mode
// PAPER + 테스트 모드 전용 엔드포인트
// ── v5: db.ts Proxy 우회, 직접 PrismaClient 사용 ──
// 핵심 변경: db.ts의 비동기 초기화 경쟁상태를 완전히 회피
// findFirst + update/create 방식으로 upsert unique 제약 의존성 제거

import { NextResponse } from 'next/server';
import { prisma, getAppSetting, setAppSetting, isPrismaAvailable, ensurePrismaConnected, getAllAppSettings } from '@/lib/prisma';
import { getEffectiveTradingSettings } from '@/lib/effective-settings';

const SETTINGS_DB_KEY = 'trading_settings';
const OVERRIDE_KEY = 'strategy_aggressiveness_override';

export async function POST() {
  try {
    console.log('[TestMode] ====== POST v5 시작 (직접 Prisma) ======');
    console.log('[TestMode] DATABASE_URL 설정됨:', !!process.env.DATABASE_URL);
    console.log('[TestMode] Prisma 사용 가능:', isPrismaAvailable());

    // Prisma 연결 보장
    const connected = await ensurePrismaConnected();
    console.log('[TestMode] Prisma 연결 상태:', connected);

    // ═══════════════════════════════════════════════════════
    // STEP 1: override 키에 strategyAggressiveness='TEST' 저장
    // ═══════════════════════════════════════════════════════
    const overrideSaved = await setAppSetting(OVERRIDE_KEY, { strategyAggressiveness: 'TEST' });
    console.log('[TestMode] STEP 1 - override 키 저장:', overrideSaved ? '성공' : '실패');

    // 검증
    let overrideVerified = false;
    const overrideRecord = await getAppSetting(OVERRIDE_KEY);
    if (overrideRecord?.value && typeof overrideRecord.value === 'object') {
      const val = (overrideRecord.value as Record<string, unknown>).strategyAggressiveness;
      overrideVerified = val === 'TEST';
      console.log('[TestMode] STEP 1 검증:', { val, overrideVerified });
    }

    // ═══════════════════════════════════════════════════════
    // STEP 2: 메인 trading_settings에 저장
    // ═══════════════════════════════════════════════════════
    // 기존 값 읽기
    let existingValue: Record<string, unknown> = {};
    const existingRecord = await getAppSetting(SETTINGS_DB_KEY);
    if (existingRecord?.value && typeof existingRecord.value === 'object') {
      existingValue = existingRecord.value as Record<string, unknown>;
    }

    // 병합
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

    // 계산값 제거
    delete mergedValue.signalThreshold;
    delete mergedValue.weakSignalThreshold;
    delete mergedValue.minConfidenceThreshold;

    // 최종 확인
    if (mergedValue.strategyAggressiveness !== 'TEST') {
      console.error('[TestMode] BUG: 병합 후 strategyAggressiveness가 TEST가 아님!', mergedValue.strategyAggressiveness);
      mergedValue.strategyAggressiveness = 'TEST';
    }

    const mainSaved = await setAppSetting(SETTINGS_DB_KEY, mergedValue);
    console.log('[TestMode] STEP 2 - 메인 trading_settings 저장:', mainSaved ? '성공' : '실패');

    // ═══════════════════════════════════════════════════════
    // STEP 3: 검증 (최대 3회 재시도)
    // ═══════════════════════════════════════════════════════
    let mainVerified = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const record = await getAppSetting(SETTINGS_DB_KEY);
      if (record?.value && typeof record.value === 'object') {
        const val = (record.value as Record<string, unknown>).strategyAggressiveness;
        mainVerified = val === 'TEST';
        console.log(`[TestMode] STEP 3 - 검증 ${attempt}/3:`, { strategyAggressiveness: val, verified: mainVerified });
      }
      if (mainVerified) break;

      // 재시도
      if (attempt < 3) {
        await setAppSetting(SETTINGS_DB_KEY, { ...mergedValue, strategyAggressiveness: 'TEST' });
      }
    }

    // ═══════════════════════════════════════════════════════
    // STEP 4: effectiveSettings 재계산
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
        prismaConnected: connected,
        prismaAvailable: isPrismaAvailable(),
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

// DELETE: TEST 모드 해제 — override 키 삭제 + CONSERVATIVE 복원
export async function DELETE() {
  try {
    console.log('[TestMode] ====== DELETE: TEST 모드 해제 ======');

    // 1) override 키 삭제
    let overrideDeleted = false;
    try {
      await ensurePrismaConnected();
      const existing = await prisma.appSetting.findFirst({ where: { key: OVERRIDE_KEY } });
      if (existing) {
        await prisma.appSetting.delete({ where: { id: existing.id } });
        overrideDeleted = true;
        console.log('[TestMode] override 키 삭제 성공');
      } else {
        overrideDeleted = true; // 이미 없음
      }
    } catch (e) {
      console.error('[TestMode] override 키 삭제 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // 2) 메인 trading_settings에서 strategyAggressiveness를 CONSERVATIVE로 변경
    let mainReset = false;
    try {
      const existingRecord = await getAppSetting(SETTINGS_DB_KEY);
      if (existingRecord?.value && typeof existingRecord.value === 'object') {
        const existingValue = { ...(existingRecord.value as Record<string, unknown>) };
        existingValue.strategyAggressiveness = 'CONSERVATIVE';
        existingValue.orderExecutionMode = 'DRY_RUN';
        existingValue.tradingMode = 'DEMO';
        delete existingValue.signalThreshold;
        delete existingValue.weakSignalThreshold;
        delete existingValue.minConfidenceThreshold;
        mainReset = await setAppSetting(SETTINGS_DB_KEY, existingValue);
      }
    } catch (e) {
      console.error('[TestMode] 메인 설정 CONSERVATIVE 복원 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // 3) effectiveSettings 재계산
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    const resetVerified = effectiveResult.strategyAggressiveness === 'CONSERVATIVE'
      && effectiveResult.orderExecutionMode === 'DRY_RUN';

    return NextResponse.json({
      success: true,
      data: effectiveResult,
      source: resultSource,
      sources: resultSources,
      verified: resetVerified,
      debug: { overrideDeleted, mainReset },
      message: resetVerified
        ? 'DRY_RUN + 보수 모드 복원 완료'
        : `복원 확인 필요: aggressiveness=${effectiveResult.strategyAggressiveness}, mode=${effectiveResult.orderExecutionMode}`,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `TEST 모드 해제 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

// GET: DB 진단 (직접 Prisma + db.ts 비교)
export async function GET() {
  try {
    const connected = await ensurePrismaConnected();

    // 1) 직접 Prisma로 전체 AppSetting 조회
    const allSettings = await getAllAppSettings();
    const overrideSetting = allSettings.find(s => s.key === OVERRIDE_KEY);
    const mainSetting = allSettings.find(s => s.key === SETTINGS_DB_KEY);

    // 2) effectiveSettings
    const { settings, source, sources } = await getEffectiveTradingSettings();

    // 3) db.ts 경로로도 조회 (비교용 — 더 이상 db.ts 사용 안 함, 진단만)
    let dbProxyType = 'Unknown';
    let dbProxyMain: unknown = null;
    let dbProxyOverride: unknown = null;
    try {
      const { getDbType } = await import('@/lib/db');
      dbProxyType = getDbType();
      // db.ts Proxy가 아닌 직접 Prisma 결과만 사용
      // dbProxyMain/Override는 'N/A (직접 Prisma 사용)'로 표시
      dbProxyMain = 'N/A (직접 Prisma 사용)';
      dbProxyOverride = 'N/A (직접 Prisma 사용)';
    } catch (_e) { /* ignore */ }

    return NextResponse.json({
      success: true,
      prisma: {
        connected,
        available: isPrismaAvailable(),
        allKeys: allSettings.map(s => s.key),
      },
      override: {
        found: !!overrideSetting,
        strategyAggressiveness: (overrideSetting?.value as Record<string, unknown>)?.strategyAggressiveness ?? null,
        fullValue: overrideSetting?.value,
      },
      main: {
        found: !!mainSetting,
        strategyAggressiveness: (mainSetting?.value as Record<string, unknown>)?.strategyAggressiveness ?? null,
        orderExecutionMode: (mainSetting?.value as Record<string, unknown>)?.orderExecutionMode ?? null,
        allKeys: mainSetting?.value && typeof mainSetting.value === 'object'
          ? Object.keys(mainSetting.value as Record<string, unknown>)
          : [],
      },
      dbProxy: {
        type: dbProxyType,
        mainStrategyAggressiveness: (dbProxyMain as Record<string, unknown>)?.strategyAggressiveness ?? null,
        overrideStrategyAggressiveness: (dbProxyOverride as Record<string, unknown>)?.strategyAggressiveness ?? null,
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
