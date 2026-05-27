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

export async function POST() {
  try {
    const existing = await db.appSetting.findUnique({
      where: { key: 'trading_settings' },
    });

    const previous =
      existing?.value && typeof existing.value === 'object'
        ? (existing.value as Record<string, unknown>)
        : {};

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

    await db.appSetting.upsert({
      where: { key: 'trading_settings' },
      create: {
        key: 'trading_settings',
        value: nextValue,
      },
      update: {
        value: nextValue,
      },
    });

    const effective = await getEffectiveTradingSettings();

    return NextResponse.json({
      success: true,
      message: 'PAPER + TEST 모드로 전환되었습니다.',
      savedSettings: nextValue,
      effectiveSettings: effective.settings,
      settingsSources: effective.sources,
    });
  } catch (error) {
    console.error('[settings/trading/test-mode] failed:', error);

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
