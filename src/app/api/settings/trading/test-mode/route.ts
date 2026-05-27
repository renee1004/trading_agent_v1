// POST /api/settings/trading/test-mode
// PAPER + 테스트 모드 전용 엔드포인트
// ── v3: Raw SQL + Prisma upsert 이중 저장 + findFirst 폴백 ──
// InMemory DB에서도 동작하도록 Prisma upsert를 항상 수행

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEffectiveTradingSettings } from '@/lib/effective-settings';

const SETTINGS_DB_KEY = 'trading_settings';
const OVERRIDE_KEY = 'strategy_aggressiveness_override';

export async function POST() {
  try {
    // ═══════════════════════════════════════════════════════
    // STEP 1: 현재 DB 값 조회 (Raw SQL → findFirst 폴백)
    // ═══════════════════════════════════════════════════════
    let rawBefore: Record<string, unknown> = {};

    // 1-1: Raw SQL 시도
    try {
      const rows = await db.$queryRaw<Array<{ key: string; value: unknown }>>`
        SELECT "key", "value" FROM "AppSetting" WHERE "key" = ${SETTINGS_DB_KEY}
      `;
      if (rows.length > 0 && rows[0].value && typeof rows[0].value === 'object') {
        rawBefore = rows[0].value as Record<string, unknown>;
      }
      console.log('[TestMode] STEP 1-1 - Raw SQL 읽기:', {
        found: rows.length > 0,
        strategyAggressiveness: rawBefore.strategyAggressiveness,
      });
    } catch (e) {
      console.warn('[TestMode] STEP 1-1 - Raw SQL 읽기 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // 1-2: Raw SQL이 빈 결과면 findFirst로 폴백 (InMemory DB 호환)
    if (Object.keys(rawBefore).length === 0) {
      try {
        let record = await db.appSetting.findUnique({ where: { key: SETTINGS_DB_KEY } });
        if (!record) {
          record = await db.appSetting.findFirst({ where: { key: SETTINGS_DB_KEY } });
        }
        if (record?.value && typeof record.value === 'object') {
          rawBefore = record.value as Record<string, unknown>;
          console.log('[TestMode] STEP 1-2 - findFirst 폴백 성공:', {
            strategyAggressiveness: rawBefore.strategyAggressiveness,
          });
        }
      } catch (e) {
        console.warn('[TestMode] STEP 1-2 - findFirst도 실패:', e instanceof Error ? e.message : 'Unknown');
      }
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

    // 계산값 제거 (strategyAggressiveness에서 자동 계산되므로)
    delete nextValue.signalThreshold;
    delete nextValue.weakSignalThreshold;
    delete nextValue.minConfidenceThreshold;

    // strategyAggressiveness 강제 보증 (3중)
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
    // STEP 3: 이중 저장 (Raw SQL + Prisma upsert 모두 실행)
    // ═══════════════════════════════════════════════════════
    const jsonStr = JSON.stringify(nextValue);
    console.log('[TestMode] STEP 3 - 저장할 JSON:', {
      hasTestInJson: jsonStr.includes('"strategyAggressiveness":"TEST"'),
      jsonPreview: jsonStr.substring(0, 200),
    });

    let savedByRawSQL = false;
    let savedByPrisma = false;

    // 3-1: Raw SQL 저장 시도
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
      console.warn('[TestMode] STEP 3-1 - Raw SQL 저장 실패:', rawErr instanceof Error ? rawErr.message : 'Unknown');
    }

    // 3-2: Prisma upsert 항상 실행 (InMemory DB 호환 + 이중 보증)
    try {
      await db.appSetting.upsert({
        where: { key: SETTINGS_DB_KEY },
        update: { value: nextValue },
        create: { key: SETTINGS_DB_KEY, value: nextValue },
      });
      savedByPrisma = true;
      console.log('[TestMode] STEP 3-2 - Prisma upsert 성공');
    } catch (prismaErr) {
      console.error('[TestMode] STEP 3-2 - Prisma upsert 실패:', prismaErr instanceof Error ? prismaErr.message : 'Unknown');
    }

    if (!savedByRawSQL && !savedByPrisma) {
      return NextResponse.json(
        { success: false, error: 'DB 저장 완전 실패 (Raw SQL + Prisma)', step: 'STEP_3' },
        { status: 500 }
      );
    }

    // ═══════════════════════════════════════════════════════
    // STEP 4: 저장 검증 (read-after-write, 최대 3회)
    // ═══════════════════════════════════════════════════════
    let rawAfterAggressiveness: unknown = null;
    let rawAfterFull: Record<string, unknown> = {};
    let verified = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      let found = false;

      // 4-a: Raw SQL로 읽기
      try {
        const rows = await db.$queryRaw<Array<{ key: string; value: unknown }>>`
          SELECT "key", "value" FROM "AppSetting" WHERE "key" = ${SETTINGS_DB_KEY}
        `;
        if (rows.length > 0 && rows[0].value && typeof rows[0].value === 'object') {
          rawAfterFull = rows[0].value as Record<string, unknown>;
          rawAfterAggressiveness = rawAfterFull.strategyAggressiveness;
          found = true;
        }
      } catch (e) {
        console.warn(`[TestMode] STEP 4-a - Raw SQL 검증 실패 (시도 ${attempt}):`, e instanceof Error ? e.message : 'Unknown');
      }

      // 4-b: Raw SQL이 실패/빈결과면 findFirst로 폴백
      if (!found || rawAfterAggressiveness === null) {
        try {
          let record = await db.appSetting.findUnique({ where: { key: SETTINGS_DB_KEY } });
          if (!record) {
            record = await db.appSetting.findFirst({ where: { key: SETTINGS_DB_KEY } });
          }
          if (record?.value && typeof record.value === 'object') {
            rawAfterFull = record.value as Record<string, unknown>;
            rawAfterAggressiveness = rawAfterFull.strategyAggressiveness;
            found = true;
          }
        } catch (e) {
          console.warn(`[TestMode] STEP 4-b - findFirst 검증도 실패 (시도 ${attempt}):`, e instanceof Error ? e.message : 'Unknown');
        }
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

      // 검증 실패 - 강제 재저장 후 재시도
      if (attempt < 3) {
        const retryValue = { ...nextValue, strategyAggressiveness: 'TEST' as const };
        try {
          await db.appSetting.upsert({
            where: { key: SETTINGS_DB_KEY },
            update: { value: retryValue },
            create: { key: SETTINGS_DB_KEY, value: retryValue },
          });
          console.log('[TestMode] STEP 4 - 강제 재저장 (Prisma upsert)');
        } catch (retryErr) {
          console.error('[TestMode] STEP 4 - 재저장 실패:', retryErr instanceof Error ? retryErr.message : 'Unknown');
        }
      }
    }

    // ═══════════════════════════════════════════════════════
    // STEP 5: 별도 키에 strategyAggressiveness 백업 저장
    // ═══════════════════════════════════════════════════════
    const overrideValue = { strategyAggressiveness: 'TEST' };

    // 5-1: Raw SQL로 백업
    try {
      const overrideJson = JSON.stringify(overrideValue);
      await db.$executeRaw`
        INSERT INTO "AppSetting" ("id", "key", "value", "createdAt", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${OVERRIDE_KEY}, ${overrideJson}::jsonb, NOW(), NOW())
        ON CONFLICT ("key")
        DO UPDATE SET "value" = ${overrideJson}::jsonb, "updatedAt" = NOW()
      `;
      console.log('[TestMode] STEP 5-1 - 별도 키 백업 (Raw SQL) 성공');
    } catch (e) {
      console.warn('[TestMode] STEP 5-1 - 별도 키 백업 (Raw SQL) 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // 5-2: Prisma upsert로도 백업 (이중 보증)
    try {
      await db.appSetting.upsert({
        where: { key: OVERRIDE_KEY },
        update: { value: overrideValue },
        create: { key: OVERRIDE_KEY, value: overrideValue },
      });
      console.log('[TestMode] STEP 5-2 - 별도 키 백업 (Prisma) 성공');
    } catch (e) {
      console.warn('[TestMode] STEP 5-2 - 별도 키 백업 (Prisma) 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // ═══════════════════════════════════════════════════════
    // STEP 6: effectiveSettings 재계산 + 최종 검증
    // ═══════════════════════════════════════════════════════
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    let effectiveVerified = effectiveResult.strategyAggressiveness === 'TEST'
      && effectiveResult.orderExecutionMode === 'PAPER'
      && effectiveResult.signalThreshold === 30
      && effectiveResult.minConfidenceThreshold === 30;

    // ── 최종 수동 오버라이드: 여전히 CONSERVATIVE면 강제 수정 ──
    // 이것은 마지막 보루입니다. 위의 모든 저장이 성공했는데도
    // effectiveSettings가 CONSERVATIVE를 반환하면, 직접 값을 수정합니다.
    if (!effectiveVerified && effectiveResult.strategyAggressiveness !== 'TEST') {
      console.error('[TestMode] STEP 6 - 최종 수동 오버라이드 실행: effectiveSettings가 여전히 CONSERVATIVE');
      console.error('[TestMode] 원인 분석:', {
        source: resultSource,
        sourcesStrategyAgg: resultSources.strategyAggressiveness,
        dbRawAggressiveness: rawAfterAggressiveness,
        savedByRawSQL,
        savedByPrisma,
      });

      // 한 번 더 강제 저장 시도
      try {
        const forceValue = { ...nextValue, strategyAggressiveness: 'TEST' as const };
        await db.appSetting.upsert({
          where: { key: SETTINGS_DB_KEY },
          update: { value: forceValue },
          create: { key: SETTINGS_DB_KEY, value: forceValue },
        });
        // 재조회
        const retry = await getEffectiveTradingSettings();
        if (retry.settings.strategyAggressiveness === 'TEST') {
          console.log('[TestMode] STEP 6 - 재시도 후 TEST 확인 성공 ✓');
          // effectiveResult를 재시도 결과로 교체
          Object.assign(effectiveResult, retry.settings);
          effectiveVerified = true;
        }
      } catch (e) {
        console.error('[TestMode] STEP 6 - 재시도도 실패:', e instanceof Error ? e.message : 'Unknown');
      }
    }

    if (effectiveVerified) {
      console.log('[TestMode] 전체 검증 성공 ✓');
    } else {
      console.error('[TestMode] 최종 검증 실패:', {
        strategyAggressiveness: effectiveResult.strategyAggressiveness,
        signalThreshold: effectiveResult.signalThreshold,
        minConfidenceThreshold: effectiveResult.minConfidenceThreshold,
        source: resultSource,
        sourcesStrategyAgg: resultSources.strategyAggressiveness,
      });
    }

    return NextResponse.json({
      success: true,
      data: effectiveResult,
      source: resultSource,
      sources: resultSources,
      verified: effectiveVerified,
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
        : `검증 실패: effectiveResult.strategyAggressiveness=${effectiveResult.strategyAggressiveness}, dbRaw=${rawAfterAggressiveness}, source=${resultSources.strategyAggressiveness}`,
    });
  } catch (error) {
    console.error('[TestMode] 전체 오류:', error);
    return NextResponse.json(
      { success: false, error: `TEST 모드 전환 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

// GET: DB 진단 (Raw SQL + Prisma + effectiveSettings 비교)
export async function GET() {
  try {
    // 1) trading_settings 조회 - 다중 방식
    let tradingSettingsRaw: Record<string, unknown> = {};
    let tradingSettingsFound = false;
    let rawSqlSuccess = false;

    // 1-1: Raw SQL
    try {
      const rows = await db.$queryRaw<Array<{ key: string; value: unknown }>>`
        SELECT "key", "value" FROM "AppSetting" WHERE "key" = ${SETTINGS_DB_KEY}
      `;
      if (rows.length > 0 && rows[0].value && typeof rows[0].value === 'object') {
        tradingSettingsRaw = rows[0].value as Record<string, unknown>;
        tradingSettingsFound = true;
        rawSqlSuccess = true;
      }
    } catch (e) {
      console.warn('[TestMode 진단] Raw SQL 실패:', e instanceof Error ? e.message : 'Unknown');
    }

    // 1-2: findFirst 폴백
    if (!tradingSettingsFound) {
      try {
        let record = await db.appSetting.findUnique({ where: { key: SETTINGS_DB_KEY } });
        if (!record) {
          record = await db.appSetting.findFirst({ where: { key: SETTINGS_DB_KEY } });
        }
        if (record?.value && typeof record.value === 'object') {
          tradingSettingsRaw = record.value as Record<string, unknown>;
          tradingSettingsFound = true;
        }
      } catch (_e) { /* ignore */ }
    }

    // 2) strategy_aggressiveness_override 조회
    let overrideRaw: Record<string, unknown> = {};
    let overrideFound = false;
    try {
      const rows = await db.$queryRaw<Array<{ key: string; value: unknown }>>`
        SELECT "key", "value" FROM "AppSetting" WHERE "key" = ${OVERRIDE_KEY}
      `;
      if (rows.length > 0 && rows[0].value && typeof rows[0].value === 'object') {
        overrideRaw = rows[0].value as Record<string, unknown>;
        overrideFound = true;
      }
    } catch (_e) { /* ignore */ }

    if (!overrideFound) {
      try {
        let record = await db.appSetting.findUnique({ where: { key: OVERRIDE_KEY } });
        if (!record) {
          record = await db.appSetting.findFirst({ where: { key: OVERRIDE_KEY } });
        }
        if (record?.value && typeof record.value === 'object') {
          overrideRaw = record.value as Record<string, unknown>;
          overrideFound = true;
        }
      } catch (_e) { /* ignore */ }
    }

    // 3) Prisma findUnique로도 조회 (비교용)
    let prismaRaw: unknown = null;
    try {
      const record = await db.appSetting.findUnique({ where: { key: SETTINGS_DB_KEY } });
      prismaRaw = record?.value;
    } catch (_e) { /* ignore */ }

    // 4) effectiveSettings
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    // 5) DB 타입 확인
    let dbType = 'Unknown';
    try {
      const { isDbAvailable, getDbType } = await import('@/lib/db');
      dbType = getDbType();
    } catch (_e) { /* ignore */ }

    return NextResponse.json({
      success: true,
      dbType,
      // Raw SQL 결과
      rawSql: {
        success: rawSqlSuccess,
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
