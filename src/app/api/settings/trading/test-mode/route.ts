// POST /api/settings/trading/test-mode
// PAPER + 테스트 모드 전용 엔드포인트
// UI 버튼이 동작하지 않을 때 강제로 모든 설정을 한 번에 저장
//
// 저장값:
//   tradingMode=DEMO, orderExecutionMode=PAPER, strategyAggressiveness=TEST
//   autoDomesticOrderEnabled=true, killSwitchEnabled=false
//   allowRealDomesticOrder=false, allowRealOverseasOrder=false
//
// 응답: 저장 후 effectiveSettings (임계값 계산 포함)
// 검증: DB read-after-write로 strategyAggressiveness=TEST 보장
// 폴백: Prisma upsert 실패 시 raw SQL로 강제 업데이트

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEffectiveTradingSettings } from '@/lib/effective-settings';

const SETTINGS_DB_KEY = 'trading_settings';

export async function POST() {
  try {
    // 1) 기존 DB 값 읽기
    const existing = await db.appSetting.findUnique({
      where: { key: SETTINGS_DB_KEY },
    });
    const previous =
      existing?.value && typeof existing.value === 'object'
        ? (existing.value as Record<string, unknown>)
        : {};

    console.log('[TestMode] 기존 DB 값:', {
      hasExisting: !!existing,
      existingAggressiveness: previous.strategyAggressiveness,
      existingOrderMode: previous.orderExecutionMode,
      existingKeys: Object.keys(previous),
    });

    // 2) 강제 설정값 병합
    const nextValue: Record<string, unknown> = {
      ...previous,
      tradingMode: 'DEMO',
      orderExecutionMode: 'PAPER',
      strategyAggressiveness: 'TEST',
      autoDomesticOrderEnabled: true,
      killSwitchEnabled: false,
      allowRealDomesticOrder: false,
      allowRealOverseasOrder: false,
    };

    // 계산값은 DB에 저장하지 않는다.
    delete nextValue.signalThreshold;
    delete nextValue.weakSignalThreshold;
    delete nextValue.minConfidenceThreshold;

    // strategyAggressiveness가 반드시 'TEST'인지 확인
    if (nextValue.strategyAggressiveness !== 'TEST') {
      console.warn('[TestMode] strategyAggressiveness가 TEST가 아님, 강제 설정:', nextValue.strategyAggressiveness);
      nextValue.strategyAggressiveness = 'TEST';
    }

    console.log('[TestMode] 병합 후 설정:', {
      strategyAggressiveness: nextValue.strategyAggressiveness,
      orderExecutionMode: nextValue.orderExecutionMode,
      tradingMode: nextValue.tradingMode,
      mergedKeys: Object.keys(nextValue),
    });

    // 3) DB에 저장 (1차 시도: Prisma upsert)
    let savedByRawSQL = false;
    try {
      await db.appSetting.upsert({
        where: { key: SETTINGS_DB_KEY },
        update: { value: nextValue },
        create: { key: SETTINGS_DB_KEY, value: nextValue },
      });
      console.log('[TestMode] TEST 모드 강제 설정 저장 성공 (Prisma upsert)', {
        strategyAggressiveness: nextValue.strategyAggressiveness,
        orderExecutionMode: nextValue.orderExecutionMode,
        tradingMode: nextValue.tradingMode,
      });
    } catch (dbError) {
      console.error('[TestMode] Prisma upsert 실패, raw SQL 시도:', dbError instanceof Error ? dbError.message : 'Unknown');

      // 폴백: Raw SQL로 강제 저장
      try {
        const jsonStr = JSON.stringify(nextValue);
        await db.$executeRaw`
          INSERT INTO "AppSetting" ("key", "value")
          VALUES (${SETTINGS_DB_KEY}, ${jsonStr}::jsonb)
          ON CONFLICT ("key")
          DO UPDATE SET "value" = ${jsonStr}::jsonb
        `;
        savedByRawSQL = true;
        console.log('[TestMode] Raw SQL 폴백 저장 성공');
      } catch (rawError) {
        console.error('[TestMode] Raw SQL 폴백도 실패:', rawError instanceof Error ? rawError.message : 'Unknown');
        return NextResponse.json(
          { success: false, error: `DB 저장 실패 (Prisma + Raw SQL): ${dbError instanceof Error ? dbError.message : 'Unknown'}` },
          { status: 500 }
        );
      }
    }

    // 4) Read-after-write 검증: DB에서 다시 읽어서 strategyAggressiveness 확인
    let savedAggressiveness: unknown = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;

    while (retryCount < MAX_RETRIES) {
      const savedRecord = await db.appSetting.findUnique({ where: { key: SETTINGS_DB_KEY } });
      const savedValue = (savedRecord?.value && typeof savedRecord.value === 'object')
        ? savedRecord.value as Record<string, unknown>
        : {};
      savedAggressiveness = savedValue.strategyAggressiveness;

      if (savedAggressiveness === 'TEST') {
        console.log('[TestMode] DB read-after-write 검증 성공', {
          retryCount,
          savedAggressiveness,
          savedOrderExecutionMode: savedValue.orderExecutionMode,
        });
        break;
      }

      retryCount++;
      console.error(`[TestMode] DB read-after-write 검증 실패 (시도 ${retryCount}/${MAX_RETRIES})`, {
        expected: 'TEST',
        actual: savedAggressiveness,
        savedValueKeys: Object.keys(savedValue),
      });

      if (retryCount < MAX_RETRIES) {
        // 강제 재저장 (raw SQL 사용)
        try {
          const jsonStr = JSON.stringify(nextValue);
          await db.$executeRaw`
            UPDATE "AppSetting" SET "value" = ${jsonStr}::jsonb
            WHERE "key" = ${SETTINGS_DB_KEY}
          `;
          console.log('[TestMode] Raw SQL 강제 재저장 시도');
        } catch (rawErr) {
          console.error('[TestMode] Raw SQL 재저장도 실패:', rawErr instanceof Error ? rawErr.message : 'Unknown');
          nextValue.strategyAggressiveness = 'TEST';
          await db.appSetting.upsert({
            where: { key: SETTINGS_DB_KEY },
            update: { value: nextValue },
            create: { key: SETTINGS_DB_KEY, value: nextValue },
          });
        }
      }
    }

    // 5) 저장 후 effectiveSettings 재계산
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    // 6) 검증: strategyAggressiveness가 실제로 TEST인지 확인
    const verified = effectiveResult.strategyAggressiveness === 'TEST'
      && effectiveResult.orderExecutionMode === 'PAPER'
      && effectiveResult.signalThreshold === 30
      && effectiveResult.minConfidenceThreshold === 30;

    if (!verified) {
      console.error('[TestMode] 저장 후 검증 실패:', {
        strategyAggressiveness: effectiveResult.strategyAggressiveness,
        orderExecutionMode: effectiveResult.orderExecutionMode,
        signalThreshold: effectiveResult.signalThreshold,
        weakSignalThreshold: effectiveResult.weakSignalThreshold,
        minConfidenceThreshold: effectiveResult.minConfidenceThreshold,
        source: resultSource,
        sourcesStrategyAgg: resultSources.strategyAggressiveness,
        sourcesOrderMode: resultSources.orderExecutionMode,
        dbSavedAggressiveness: savedAggressiveness,
        savedByRawSQL,
        retryCount,
      });
    } else {
      console.log('[TestMode] 전체 검증 성공 ✓', {
        strategyAggressiveness: effectiveResult.strategyAggressiveness,
        orderExecutionMode: effectiveResult.orderExecutionMode,
        signalThreshold: effectiveResult.signalThreshold,
        weakSignalThreshold: effectiveResult.weakSignalThreshold,
        minConfidenceThreshold: effectiveResult.minConfidenceThreshold,
        source: resultSources.strategyAggressiveness,
      });
    }

    return NextResponse.json({
      success: true,
      data: effectiveResult,
      source: resultSource,
      sources: resultSources,
      verified,
      dbVerification: {
        savedAggressiveness,
        retryCount,
        savedByRawSQL,
      },
      message: verified
        ? 'TEST 모드 전환 완료: DEMO/PAPER/TEST, signalThreshold=30, weakSignalThreshold=25, minConfidence=30'
        : 'TEST 모드 전환 후 검증 실패 — 서버 로그를 확인하세요',
      appliedSettings: nextValue,
    });
  } catch (error) {
    console.error('[TestMode] 전체 오류:', error instanceof Error ? error.message : 'Unknown', error);
    return NextResponse.json(
      {
        success: false,
        error: 'PAPER + TEST 모드 전환 실패',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// GET: 현재 DB 상태 진단 (raw DB 값 직접 확인)
export async function GET() {
  try {
    const record = await db.appSetting.findUnique({ where: { key: SETTINGS_DB_KEY } });
    const rawValue = record?.value;
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    return NextResponse.json({
      success: true,
      dbRaw: {
        exists: !!record,
        value: rawValue,
        strategyAggressiveness: (rawValue as Record<string, unknown>)?.strategyAggressiveness ?? null,
        orderExecutionMode: (rawValue as Record<string, unknown>)?.orderExecutionMode ?? null,
        tradingMode: (rawValue as Record<string, unknown>)?.tradingMode ?? null,
      },
      effective: {
        strategyAggressiveness: effectiveResult.strategyAggressiveness,
        orderExecutionMode: effectiveResult.orderExecutionMode,
        tradingMode: effectiveResult.tradingMode,
        signalThreshold: effectiveResult.signalThreshold,
        weakSignalThreshold: effectiveResult.weakSignalThreshold,
        minConfidenceThreshold: effectiveResult.minConfidenceThreshold,
      },
      source: resultSource,
      sources: {
        strategyAggressiveness: resultSources.strategyAggressiveness,
        orderExecutionMode: resultSources.orderExecutionMode,
        signalThreshold: resultSources.signalThreshold,
        minConfidenceThreshold: resultSources.minConfidenceThreshold,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `진단 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
