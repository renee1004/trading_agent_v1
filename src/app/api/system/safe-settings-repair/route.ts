// POST /api/system/safe-settings-repair
// DB에 저장된 위험 설정을 안전값으로 강제 보정
//
// GET: 현재 DB 설정 상태 조회 (보정 없이)
// POST: confirm=SAFE_SETTINGS_REPAIR 확인 시 DB 직접 보정
//
// 보정 내용:
//   - strategyAggressiveness → CONSERVATIVE
//   - autoDomesticOrderEnabled → false
//   - autoExitEnabled → false
//   - killSwitchEnabled → true
//   - 계산 필드 제거 (signalThreshold, weakSignalThreshold, ...)
//   - strategy_aggressiveness_override → CONSERVATIVE

import { NextRequest, NextResponse } from 'next/server';
import { getAppSetting, setAppSetting } from '@/lib/prisma';

const MAIN_KEY = 'trading_settings';
const OVERRIDE_KEY = 'strategy_aggressiveness_override';
const REQUIRED_CONFIRM = 'SAFE_SETTINGS_REPAIR';

interface Diagnosis {
  key: string;
  field: string;
  currentValue: unknown;
  expectedValue: unknown;
  needsRepair: boolean;
}

export async function GET() {
  try {
    const mainRecord = await getAppSetting(MAIN_KEY);
    const overrideRecord = await getAppSetting(OVERRIDE_KEY);

    const mainValue = (mainRecord?.value && typeof mainRecord.value === 'object')
      ? mainRecord.value as Record<string, unknown>
      : {};
    const overrideValue = (overrideRecord?.value && typeof overrideRecord.value === 'object')
      ? overrideRecord.value as Record<string, unknown>
      : {};

    const diagnoses: Diagnosis[] = [];

    // 메인 키 진단
    const mainChecks: Array<[string, unknown, unknown]> = [
      ['strategyAggressiveness', mainValue.strategyAggressiveness, 'CONSERVATIVE'],
      ['autoDomesticOrderEnabled', mainValue.autoDomesticOrderEnabled, false],
      ['autoExitEnabled', mainValue.autoExitEnabled, false],
      ['killSwitchEnabled', mainValue.killSwitchEnabled, true],
      ['maxOpenDomesticPositions', mainValue.maxOpenDomesticPositions, 3],
      ['maxOpenPositions', mainValue.maxOpenPositions, 3],
    ];

    for (const [field, current, expected] of mainChecks) {
      diagnoses.push({
        key: MAIN_KEY,
        field,
        currentValue: current,
        expectedValue: expected,
        needsRepair: current !== expected,
      });
    }

    // 계산 필드 존재 여부 진단
    const computedFields = ['signalThreshold', 'weakSignalThreshold', 'minConfidenceThreshold', 'accountRiskPercent', 'useATRStop', 'partialTakeProfit', 'indexFilter'];
    for (const field of computedFields) {
      const exists = mainValue[field] !== undefined;
      diagnoses.push({
        key: MAIN_KEY,
        field,
        currentValue: exists ? mainValue[field] : '(not set)',
        expectedValue: '(removed — auto-computed from strategyAggressiveness)',
        needsRepair: exists,
      });
    }

    // override 키 진단
    const overrideStrategy = overrideValue.strategyAggressiveness;
    diagnoses.push({
      key: OVERRIDE_KEY,
      field: 'strategyAggressiveness',
      currentValue: overrideStrategy ?? '(not set)',
      expectedValue: 'CONSERVATIVE',
      needsRepair: overrideStrategy !== undefined && overrideStrategy !== 'CONSERVATIVE',
    });

    const needsRepair = diagnoses.some(d => d.needsRepair);

    return NextResponse.json({
      success: true,
      needsRepair,
      diagnoses,
      repairInstructions: needsRepair
        ? `POST with { "confirm": "${REQUIRED_CONFIRM}" } to apply repairs`
        : 'All settings are already safe',
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `진단 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.confirm !== REQUIRED_CONFIRM) {
      return NextResponse.json({
        success: false,
        error: `confirm 필드가 "${REQUIRED_CONFIRM}"이 아닙니다`,
        hint: `POST { "confirm": "${REQUIRED_CONFIRM}" }`,
      }, { status: 400 });
    }

    const results: Array<{ key: string; success: boolean; detail: string }> = [];

    // 1) 메인 키 보정
    const mainRecord = await getAppSetting(MAIN_KEY);
    const mainValue = (mainRecord?.value && typeof mainRecord.value === 'object')
      ? { ...(mainRecord.value as Record<string, unknown>) }
      : {};

    // 강제 설정
    mainValue.strategyAggressiveness = 'CONSERVATIVE';
    mainValue.autoDomesticOrderEnabled = false;
    mainValue.autoExitEnabled = false;
    mainValue.killSwitchEnabled = true;
    mainValue.maxOpenDomesticPositions = 3;
    mainValue.maxOpenPositions = 3;

    // 계산 필드 제거
    for (const field of ['signalThreshold', 'weakSignalThreshold', 'minConfidenceThreshold', 'accountRiskPercent', 'useATRStop', 'partialTakeProfit', 'indexFilter']) {
      delete mainValue[field];
    }

    const mainSaved = await setAppSetting(MAIN_KEY, mainValue);
    results.push({
      key: MAIN_KEY,
      success: !!mainSaved,
      detail: mainSaved ? 'CONSERVATIVE + 안전모드 적용, 계산 필드 제거' : '저장 실패',
    });

    // 2) override 키 보정
    const overrideSaved = await setAppSetting(OVERRIDE_KEY, { strategyAggressiveness: 'CONSERVATIVE' });
    results.push({
      key: OVERRIDE_KEY,
      success: !!overrideSaved,
      detail: 'CONSERVATIVE로 덮어씀',
    });

    // 3) 검증 읽기
    const verifyMain = await getAppSetting(MAIN_KEY);
    const verifyOverride = await getAppSetting(OVERRIDE_KEY);
    const verifyMainValue = (verifyMain?.value && typeof verifyMain.value === 'object')
      ? verifyMain.value as Record<string, unknown>
      : {};
    const verifyOverrideValue = (verifyOverride?.value && typeof verifyOverride.value === 'object')
      ? verifyOverride.value as Record<string, unknown>
      : {};

    const allSafe =
      verifyMainValue.strategyAggressiveness === 'CONSERVATIVE' &&
      verifyMainValue.autoDomesticOrderEnabled === false &&
      verifyMainValue.killSwitchEnabled === true &&
      verifyOverrideValue.strategyAggressiveness === 'CONSERVATIVE';

    return NextResponse.json({
      success: true,
      allSafe,
      results,
      verified: {
        main: {
          strategyAggressiveness: verifyMainValue.strategyAggressiveness,
          autoDomesticOrderEnabled: verifyMainValue.autoDomesticOrderEnabled,
          autoExitEnabled: verifyMainValue.autoExitEnabled,
          killSwitchEnabled: verifyMainValue.killSwitchEnabled,
          maxOpenDomesticPositions: verifyMainValue.maxOpenDomesticPositions,
        },
        override: {
          strategyAggressiveness: verifyOverrideValue.strategyAggressiveness,
        },
      },
      warning: !allSafe ? '검증 실패 — 런타임 안전 보정(effective-settings.ts)에 의해 보호됩니다' : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `보정 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}