// 안전 운용 설정 보정 API
// 목적: Railway 런타임에서 DB AppSetting(trading_settings)이 코드 기본값을 덮어쓰는 경우,
//       운영 안전값을 명시적으로 DB에 저장한다.
//
// 이 API는 값을 더 위험하게 만들지 않고 아래 안전값으로만 보정한다.
// - strategyAggressiveness = CONSERVATIVE
// - autoDomesticOrderEnabled = false
// - autoExitEnabled = false
// - killSwitchEnabled = true
// - maxOpenDomesticPositions = 3
// - 테스트/공격 프리셋에서 남은 계산 임계값 제거

import { NextRequest, NextResponse } from 'next/server';
import { getAppSetting, setAppSetting } from '@/lib/prisma';

const SETTINGS_DB_KEY = 'trading_settings';
const OVERRIDE_DB_KEY = 'strategy_aggressiveness_override';
const REQUIRED_CONFIRM = 'SAFE_SETTINGS_REPAIR';

function stripCalculatedStrategyFields(value: Record<string, unknown>) {
  delete value.signalThreshold;
  delete value.weakSignalThreshold;
  delete value.minConfidenceThreshold;
  delete value.accountRiskPercent;
  delete value.useATRStop;
  delete value.partialTakeProfit;
  delete value.indexFilter;
  return value;
}

function buildSafeTradingSettings(existingValue: Record<string, unknown>) {
  const repaired = stripCalculatedStrategyFields({ ...existingValue });

  repaired.strategyAggressiveness = 'CONSERVATIVE';
  repaired.autoDomesticOrderEnabled = false;
  repaired.autoExitEnabled = false;
  repaired.killSwitchEnabled = true;
  repaired.maxOpenDomesticPositions = 3;
  repaired.maxOpenPositions = 3;
  repaired.allowRealDomesticOrder = false;
  repaired.allowRealOverseasOrder = false;
  repaired.enableOverseasOrder = false;
  repaired.allowAfterHoursTrading = false;

  // DEMO/PAPER는 유지 가능하지만, 주문 가능 여부는 autoDomesticOrderEnabled=false + killSwitch=true가 차단한다.
  if (repaired.tradingMode !== 'DEMO' && repaired.tradingMode !== 'REAL') {
    repaired.tradingMode = 'DEMO';
  }
  if (repaired.orderExecutionMode !== 'DRY_RUN' && repaired.orderExecutionMode !== 'PAPER' && repaired.orderExecutionMode !== 'LIVE') {
    repaired.orderExecutionMode = 'DRY_RUN';
  }

  return repaired;
}

async function readObjectSetting(key: string): Promise<Record<string, unknown>> {
  const record = await getAppSetting(key);
  return record?.value && typeof record.value === 'object'
    ? record.value as Record<string, unknown>
    : {};
}

export async function GET() {
  try {
    const tradingSettings = await readObjectSetting(SETTINGS_DB_KEY);
    const overrideSettings = await readObjectSetting(OVERRIDE_DB_KEY);

    return NextResponse.json({
      success: true,
      data: {
        tradingSettingsPreview: {
          strategyAggressiveness: tradingSettings.strategyAggressiveness ?? null,
          autoDomesticOrderEnabled: tradingSettings.autoDomesticOrderEnabled ?? null,
          autoExitEnabled: tradingSettings.autoExitEnabled ?? null,
          killSwitchEnabled: tradingSettings.killSwitchEnabled ?? null,
          maxOpenPositions: tradingSettings.maxOpenPositions ?? null,
          maxOpenDomesticPositions: tradingSettings.maxOpenDomesticPositions ?? null,
          orderExecutionMode: tradingSettings.orderExecutionMode ?? null,
          tradingMode: tradingSettings.tradingMode ?? null,
        },
        overridePreview: {
          strategyAggressiveness: overrideSettings.strategyAggressiveness ?? null,
        },
        repairEndpoint: 'POST /api/system/safe-settings-repair',
        requiredBody: { confirm: REQUIRED_CONFIRM },
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `안전 설정 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.confirm !== REQUIRED_CONFIRM) {
      return NextResponse.json(
        {
          success: false,
          error: `confirm 값이 필요합니다. body에 {"confirm":"${REQUIRED_CONFIRM}"} 를 보내세요.`,
        },
        { status: 400 }
      );
    }

    const beforeTradingSettings = await readObjectSetting(SETTINGS_DB_KEY);
    const beforeOverrideSettings = await readObjectSetting(OVERRIDE_DB_KEY);

    const repairedTradingSettings = buildSafeTradingSettings(beforeTradingSettings);
    const repairedOverrideSettings = {
      ...beforeOverrideSettings,
      strategyAggressiveness: 'CONSERVATIVE',
    };

    const tradingSaved = await setAppSetting(SETTINGS_DB_KEY, repairedTradingSettings);
    const overrideSaved = await setAppSetting(OVERRIDE_DB_KEY, repairedOverrideSettings);

    const afterTradingSettings = await readObjectSetting(SETTINGS_DB_KEY);
    const afterOverrideSettings = await readObjectSetting(OVERRIDE_DB_KEY);

    return NextResponse.json({
      success: tradingSaved && overrideSaved,
      data: {
        tradingSettings: {
          before: {
            strategyAggressiveness: beforeTradingSettings.strategyAggressiveness ?? null,
            autoDomesticOrderEnabled: beforeTradingSettings.autoDomesticOrderEnabled ?? null,
            autoExitEnabled: beforeTradingSettings.autoExitEnabled ?? null,
            killSwitchEnabled: beforeTradingSettings.killSwitchEnabled ?? null,
            maxOpenPositions: beforeTradingSettings.maxOpenPositions ?? null,
            maxOpenDomesticPositions: beforeTradingSettings.maxOpenDomesticPositions ?? null,
          },
          after: {
            strategyAggressiveness: afterTradingSettings.strategyAggressiveness ?? null,
            autoDomesticOrderEnabled: afterTradingSettings.autoDomesticOrderEnabled ?? null,
            autoExitEnabled: afterTradingSettings.autoExitEnabled ?? null,
            killSwitchEnabled: afterTradingSettings.killSwitchEnabled ?? null,
            maxOpenPositions: afterTradingSettings.maxOpenPositions ?? null,
            maxOpenDomesticPositions: afterTradingSettings.maxOpenDomesticPositions ?? null,
          },
        },
        override: {
          before: {
            strategyAggressiveness: beforeOverrideSettings.strategyAggressiveness ?? null,
          },
          after: {
            strategyAggressiveness: afterOverrideSettings.strategyAggressiveness ?? null,
          },
        },
      },
      message: '안전 운용 설정 보정 완료. /api/agent/status에서 effectiveSettings를 다시 확인하세요.',
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `안전 설정 보정 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
