// POST /api/settings/trading/test-mode
// PAPER + 테스트 모드 전용 엔드포인트
// ── 핵심 수정: Prisma upsert 대신 Raw SQL만 사용 ──
// Prisma의 Json 필드 직렬화가 strategyAggressiveness를 누락시키는 버그 회피
// 모든 DB 읽기/쓰기를 $queryRaw/$executeRaw로 직접 수행

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEffectiveTradingSettings } from '@/lib/effective-settings';

const SETTINGS_DB_KEY = 'trading_settings';

export async function POST() {
  try {
    // ═══════════════════════════════════════════════════════
    // STEP 1: Raw SQL로 현재 DB 값 직접 조회
    // ═══════════════════════════════════════════════════════
    let rawBefore: Record<string, unknown> = {};
    try {
      const rows = await db.$queryRaw<Array<{ key: string; value: unknown }>>`
        SELECT "key", "value" FROM "AppSetting" WHERE "key" = ${SETTINGS_DB_KEY}
      `;
      if (rows.length > 0 && rows[0].value && typeof rows[0].value === 'object') {
        rawBefore = rows[0].value as Record<string, unknown>;
      }
      console.log('[TestMode] STEP 1 - Raw SQL 읽기 (BEFORE):', {
        found: rows.length > 0,
        strategyAggressiveness: rawBefore.strategyAggressiveness,
        orderExecutionMode: rawBefore.orderExecutionMode,
        allKeys: Object.keys(rawBefore),
      });
    } catch (e) {
      console.error('[TestMode] STEP 1 - Raw SQL 읽기 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // ═══════════════════════════════════════════════════════
    // STEP 2: 강제 설정값 구성 (기존값 + TEST 오버라이드)
    // ═══════════════════════════════════════════════════════
    const nextValue: Record<string, unknown> = {
      ...rawBefore,
      tradingMode: 'DEMO',
      orderExecutionMode: 'PAPER',
      strategyAggressiveness: 'TEST',   // ← 핵심: 반드시 TEST
      autoDomesticOrderEnabled: true,
      killSwitchEnabled: false,
      allowRealDomesticOrder: false,
      allowRealOverseasOrder: false,
    };

    // 계산값 제거
    delete nextValue.signalThreshold;
    delete nextValue.weakSignalThreshold;
    delete nextValue.minConfidenceThreshold;

    // strategyAggressiveness 강제 보증
    if (nextValue.strategyAggressiveness !== 'TEST') {
      console.error('[TestMode] BUG: strategyAggressiveness가 TEST가 아님!', nextValue.strategyAggressiveness);
      nextValue.strategyAggressiveness = 'TEST';
    }

    console.log('[TestMode] STEP 2 - 병합 완료:', {
      strategyAggressiveness: nextValue.strategyAggressiveness,
      orderExecutionMode: nextValue.orderExecutionMode,
      keyCount: Object.keys(nextValue).length,
    });

    // ═══════════════════════════════════════════════════════
    // STEP 3: Raw SQL로 직접 저장 (Prisma upsert 완전 우회)
    // ═══════════════════════════════════════════════════════
    const jsonStr = JSON.stringify(nextValue);
    console.log('[TestMode] STEP 3 - 저장할 JSON (strategyAggressiveness 확인):', {
      hasTestInJson: jsonStr.includes('"strategyAggressiveness":"TEST"'),
      jsonPreview: jsonStr.substring(0, 300),
    });

    let savedByRawSQL = false;
    let savedByPrisma = false;

    // 3-1: Raw SQL 먼저 시도
    try {
      await db.$executeRaw`
        INSERT INTO "AppSetting" ("id", "key", "value", "createdAt", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${SETTINGS_DB_KEY}, ${jsonStr}::jsonb, NOW(), NOW())
        ON CONFLICT ("key")
        DO UPDATE SET "value" = ${jsonStr}::jsonb, "updatedAt" = NOW()
      `;
      savedByRawSQL = true;
      console.log('[TestMode] STEP 3-1 - Raw SQL 저장 성공');
    } catch (rawErr) {
      console.error('[TestMode] STEP 3-1 - Raw SQL 저장 실패:', rawErr instanceof Error ? rawErr.message : 'Unknown');

      // 3-2: Prisma upsert 폴백
      try {
        await db.appSetting.upsert({
          where: { key: SETTINGS_DB_KEY },
          update: { value: nextValue },
          create: { key: SETTINGS_DB_KEY, value: nextValue },
        });
        savedByPrisma = true;
        console.log('[TestMode] STEP 3-2 - Prisma upsert 폴백 성공');
      } catch (prismaErr) {
        console.error('[TestMode] STEP 3-2 - Prisma upsert도 실패:', prismaErr instanceof Error ? prismaErr.message : 'Unknown');
        return NextResponse.json(
          { success: false, error: 'DB 저장 완전 실패 (Raw SQL + Prisma)', step: 'STEP_3' },
          { status: 500 }
        );
      }
    }

    // ═══════════════════════════════════════════════════════
    // STEP 4: Raw SQL로 저장 검증 (read-after-write)
    // ═══════════════════════════════════════════════════════
    let rawAfterAggressiveness: unknown = null;
    let rawAfterFull: Record<string, unknown> = {};
    let verified = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const rows = await db.$queryRaw<Array<{ key: string; value: unknown }>>`
          SELECT "key", "value" FROM "AppSetting" WHERE "key" = ${SETTINGS_DB_KEY}
        `;
        if (rows.length > 0 && rows[0].value && typeof rows[0].value === 'object') {
          rawAfterFull = rows[0].value as Record<string, unknown>;
          rawAfterAggressiveness = rawAfterFull.strategyAggressiveness;
        }

        console.log(`[TestMode] STEP 4 - 검증 시도 ${attempt}/3:`, {
          strategyAggressiveness: rawAfterAggressiveness,
          orderExecutionMode: rawAfterFull.orderExecutionMode,
          allKeys: Object.keys(rawAfterFull),
        });

        if (rawAfterAggressiveness === 'TEST') {
          verified = true;
          break;
        }

        // 검증 실패 - 재시도
        if (attempt < 3) {
          // 강제 재저장
          const retryJson = JSON.stringify({ ...nextValue, strategyAggressiveness: 'TEST' });
          try {
            await db.$executeRaw`
              UPDATE "AppSetting" SET "value" = ${retryJson}::jsonb, "updatedAt" = NOW()
              WHERE "key" = ${SETTINGS_DB_KEY}
            `;
          } catch (retryErr) {
            console.error('[TestMode] STEP 4 - 재저장 실패:', retryErr instanceof Error ? retryErr.message : 'Unknown');
          }
        }
      } catch (e) {
        console.error(`[TestMode] STEP 4 - 검증 조회 실패 (시도 ${attempt}):`, e instanceof Error ? e.message : 'Unknown');
      }
    }

    // ═══════════════════════════════════════════════════════
    // STEP 5: 별도 키에 strategyAggressiveness 백업 저장 (초강력 폴백)
    // ═══════════════════════════════════════════════════════
    const OVERRIDE_KEY = 'strategy_aggressiveness_override';
    try {
      const overrideValue = JSON.stringify({ strategyAggressiveness: 'TEST' });
      await db.$executeRaw`
        INSERT INTO "AppSetting" ("id", "key", "value", "createdAt", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${OVERRIDE_KEY}, ${overrideValue}::jsonb, NOW(), NOW())
        ON CONFLICT ("key")
        DO UPDATE SET "value" = ${overrideValue}::jsonb, "updatedAt" = NOW()
      `;
      console.log('[TestMode] STEP 5 - 별도 키 백업 저장 성공:', OVERRIDE_KEY);
    } catch (e) {
      console.error('[TestMode] STEP 5 - 별도 키 백업 저장 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // ═══════════════════════════════════════════════════════
    // STEP 6: effectiveSettings 재계산
    // ═══════════════════════════════════════════════════════
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    const effectiveVerified = effectiveResult.strategyAggressiveness === 'TEST'
      && effectiveResult.orderExecutionMode === 'PAPER'
      && effectiveResult.signalThreshold === 30
      && effectiveResult.minConfidenceThreshold === 30;

    if (!effectiveVerified) {
      console.error('[TestMode] STEP 6 - effectiveSettings 검증 실패:', {
        strategyAggressiveness: effectiveResult.strategyAggressiveness,
        orderExecutionMode: effectiveResult.orderExecutionMode,
        signalThreshold: effectiveResult.signalThreshold,
        minConfidenceThreshold: effectiveResult.minConfidenceThreshold,
        source: resultSource,
        sourcesStrategyAgg: resultSources.strategyAggressiveness,
        dbRawAggressiveness: rawAfterAggressiveness,
      });
    } else {
      console.log('[TestMode] STEP 6 - 전체 검증 성공 ✓');
    }

    return NextResponse.json({
      success: true,
      data: effectiveResult,
      source: resultSource,
      sources: resultSources,
      verified: effectiveVerified,
      // 디버깅 정보
      debug: {
        beforeAggressiveness: rawBefore.strategyAggressiveness,
        afterAggressiveness: rawAfterAggressiveness,
        savedByRawSQL,
        savedByPrisma,
        overrideKeySaved: true,
        jsonHadTest: jsonStr.includes('"strategyAggressiveness":"TEST"'),
      },
      message: effectiveVerified
        ? 'TEST 모드 전환 완료 ✓ signalThreshold=30, minConfidence=30'
        : `검증 실패: effectiveResult.strategyAggressiveness=${effectiveResult.strategyAggressiveness}, dbRaw=${rawAfterAggressiveness}`,
    });
  } catch (error) {
    console.error('[TestMode] 전체 오류:', error);
    return NextResponse.json(
      { success: false, error: `TEST 모드 전환 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

// GET: DB 진단 (Raw SQL로 직접 확인)
export async function GET() {
  try {
    // 1) trading_settings Raw SQL 조회
    let tradingSettingsRaw: Record<string, unknown> = {};
    let tradingSettingsFound = false;
    try {
      const rows = await db.$queryRaw<Array<{ key: string; value: unknown }>>`
        SELECT "key", "value" FROM "AppSetting" WHERE "key" = ${SETTINGS_DB_KEY}
      `;
      if (rows.length > 0 && rows[0].value && typeof rows[0].value === 'object') {
        tradingSettingsRaw = rows[0].value as Record<string, unknown>;
        tradingSettingsFound = true;
      }
    } catch (e) {
      console.error('[TestMode 진단] Raw SQL 조회 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // 2) strategy_aggressiveness_override Raw SQL 조회
    let overrideRaw: Record<string, unknown> = {};
    let overrideFound = false;
    try {
      const rows = await db.$queryRaw<Array<{ key: string; value: unknown }>>`
        SELECT "key", "value" FROM "AppSetting" WHERE "key" = 'strategy_aggressiveness_override'
      `;
      if (rows.length > 0 && rows[0].value && typeof rows[0].value === 'object') {
        overrideRaw = rows[0].value as Record<string, unknown>;
        overrideFound = true;
      }
    } catch (_e) { /* ignore */ }

    // 3) Prisma findUnique로도 조회 (비교용)
    let prismaRaw: unknown = null;
    try {
      const record = await db.appSetting.findUnique({ where: { key: SETTINGS_DB_KEY } });
      prismaRaw = record?.value;
    } catch (_e) { /* ignore */ }

    // 4) effectiveSettings
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    return NextResponse.json({
      success: true,
      // Raw SQL 결과
      rawSql: {
        tradingSettingsFound,
        strategyAggressiveness: tradingSettingsRaw.strategyAggressiveness ?? null,
        orderExecutionMode: tradingSettingsRaw.orderExecutionMode ?? null,
        allKeys: Object.keys(tradingSettingsRaw),
        fullValue: tradingSettingsRaw,
      },
      // Override 키 결과
      override: {
        found: overrideFound,
        strategyAggressiveness: overrideRaw.strategyAggressiveness ?? null,
      },
      // Prisma 결과 (비교용)
      prisma: {
        strategyAggressiveness: (prismaRaw as Record<string, unknown>)?.strategyAggressiveness ?? null,
      },
      // effectiveSettings 결과
      effective: {
        strategyAggressiveness: effectiveResult.strategyAggressiveness,
        orderExecutionMode: effectiveResult.orderExecutionMode,
        signalThreshold: effectiveResult.signalThreshold,
        weakSignalThreshold: effectiveResult.weakSignalThreshold,
        minConfidenceThreshold: effectiveResult.minConfidenceThreshold,
      },
      source: resultSource,
      sources: {
        strategyAggressiveness: resultSources.strategyAggressiveness,
        orderExecutionMode: resultSources.orderExecutionMode,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `진단 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
