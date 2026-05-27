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

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEffectiveTradingSettings } from '@/lib/effective-settings';

const SETTINGS_DB_KEY = 'trading_settings';

export async function POST() {
  try {
    // 1) 강제 설정값
    const forceSettings: Record<string, unknown> = {
      tradingMode: 'DEMO',
      orderExecutionMode: 'PAPER',
      strategyAggressiveness: 'TEST',
      autoDomesticOrderEnabled: true,
      killSwitchEnabled: false,
      allowRealDomesticOrder: false,
      allowRealOverseasOrder: false,
    };

    // 2) 기존 DB 값 읽기 + 병합
    const existing = await db.appSetting.findUnique({ where: { key: SETTINGS_DB_KEY } });
    const existingValue = (existing?.value && typeof existing.value === 'object')
      ? existing.value as Record<string, unknown>
      : {};

    const merged = { ...existingValue, ...forceSettings };

    // 계산된 임계값 제거 (strategyAggressiveness로부터 자동 계산)
    delete merged.signalThreshold;
    delete merged.weakSignalThreshold;
    delete merged.minConfidenceThreshold;

    // strategyAggressiveness가 반드시 'TEST'인지 확인
    if (merged.strategyAggressiveness !== 'TEST') {
      console.warn('[TestMode] strategyAggressiveness가 TEST가 아님, 강제 설정:', merged.strategyAggressiveness);
      merged.strategyAggressiveness = 'TEST';
    }

    // 3) DB에 저장
    try {
      await db.appSetting.upsert({
        where: { key: SETTINGS_DB_KEY },
        update: { value: merged },
        create: { key: SETTINGS_DB_KEY, value: merged },
      });
      console.log('[TestMode] TEST 모드 강제 설정 저장 성공 (1차)', {
        strategyAggressiveness: merged.strategyAggressiveness,
        orderExecutionMode: merged.orderExecutionMode,
        tradingMode: merged.tradingMode,
      });
    } catch (dbError) {
      console.error('[TestMode] DB 저장 실패:', dbError instanceof Error ? dbError.message : 'Unknown');
      return NextResponse.json(
        { success: false, error: `DB 저장 실패: ${dbError instanceof Error ? dbError.message : 'Unknown'}` },
        { status: 500 }
      );
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
        // 저장 성공 확인
        console.log('[TestMode] DB read-after-write 검증 성공', {
          retryCount,
          savedAggressiveness,
          savedOrderExecutionMode: savedValue.orderExecutionMode,
        });
        break;
      }

      // 저장 실패 - 재시도
      retryCount++;
      console.error(`[TestMode] DB read-after-write 검증 실패 (시도 ${retryCount}/${MAX_RETRIES})`, {
        expected: 'TEST',
        actual: savedAggressiveness,
        savedValueKeys: Object.keys(savedValue),
        allValues: savedValue,
      });

      if (retryCount < MAX_RETRIES) {
        // 강제 재저장
        merged.strategyAggressiveness = 'TEST';
        await db.appSetting.upsert({
          where: { key: SETTINGS_DB_KEY },
          update: { value: merged },
          create: { key: SETTINGS_DB_KEY, value: merged },
        });
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
        minConfidenceThreshold: effectiveResult.minConfidenceThreshold,
        source: resultSource,
        sourcesStrategyAgg: resultSources.strategyAggressiveness,
        dbSavedAggressiveness: savedAggressiveness,
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
      },
      message: verified
        ? 'TEST 모드 전환 완료: DEMO/PAPER/TEST, signalThreshold=30, minConfidence=30'
        : 'TEST 모드 전환 후 검증 실패 — 서버 로그를 확인하세요',
      appliedSettings: forceSettings,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `TEST 모드 전환 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
