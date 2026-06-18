// POST /api/system/safe-mode
// 자동매수/자동청산/실전주문을 모두 강제 차단하는 안전모드 토글
// 단가 신뢰성 문제가 해결될 때까지 임시 보호 목적
//
// 요청 본문:
//   { enabled: true }  -> safe-mode ON  (autoDomesticOrderEnabled=false, autoExitEnabled=false, killSwitchEnabled=true, allowReal*=false)
//   { enabled: false } -> safe-mode OFF (이전 값 복구 시도 — autoDomesticOrderEnabled=true, autoExitEnabled=true, killSwitchEnabled=false)
//   (본문 없음)        -> 현재 상태 조회만

import { NextRequest, NextResponse } from 'next/server';
import { getAppSetting, setAppSetting } from '@/lib/prisma';
import { getEffectiveTradingSettings } from '@/lib/effective-settings';

const SETTINGS_DB_KEY = 'trading_settings';

export async function GET() {
  try {
    const { settings, sources } = await getEffectiveTradingSettings();
    const safeModeActive =
      settings.killSwitchEnabled === true ||
      settings.autoDomesticOrderEnabled === false ||
      settings.autoExitEnabled === false;

    return NextResponse.json({
      success: true,
      safeModeActive,
      current: {
        autoDomesticOrderEnabled: settings.autoDomesticOrderEnabled,
        autoExitEnabled: settings.autoExitEnabled,
        killSwitchEnabled: settings.killSwitchEnabled,
        allowRealDomesticOrder: settings.allowRealDomesticOrder,
        allowRealOverseasOrder: settings.allowRealOverseasOrder,
      },
      sources: {
        autoDomesticOrderEnabled: sources.autoDomesticOrderEnabled,
        autoExitEnabled: sources.autoExitEnabled,
        killSwitchEnabled: sources.killSwitchEnabled,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `상태 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const enable = body?.enabled === true;

    // 1) 기존 DB 설정 읽기
    const existing = await getAppSetting(SETTINGS_DB_KEY);
    const existingValue: Record<string, unknown> =
      existing?.value && typeof existing.value === 'object'
        ? (existing.value as Record<string, unknown>)
        : {};

    // 2) 새 값 계산
    const newValue: Record<string, unknown> = { ...existingValue };
    if (enable) {
      // 안전모드 ON
      newValue.autoDomesticOrderEnabled = false;
      newValue.autoExitEnabled = false;
      newValue.killSwitchEnabled = true;
      newValue.allowRealDomesticOrder = false;
      newValue.allowRealOverseasOrder = false;
    } else {
      // 안전모드 OFF — 보수적 기본값으로 복구
      newValue.autoDomesticOrderEnabled = true;
      newValue.autoExitEnabled = true;
      newValue.killSwitchEnabled = false;
      newValue.allowRealDomesticOrder = false;
      newValue.allowRealOverseasOrder = false;
    }

    // 3) 저장
    const saved = await setAppSetting(SETTINGS_DB_KEY, newValue);
    if (!saved) {
      return NextResponse.json(
        { success: false, error: 'DB 저장 실패 — setAppSetting이 false 반환' },
        { status: 500 }
      );
    }

    // 4) 검증 읽기
    const verify = await getAppSetting(SETTINGS_DB_KEY);
    const verifiedValue = (verify?.value ?? {}) as Record<string, unknown>;

    return NextResponse.json({
      success: true,
      safeModeActive: enable,
      action: enable ? 'ENABLED' : 'DISABLED',
      saved: newValue,
      verified: {
        autoDomesticOrderEnabled: verifiedValue.autoDomesticOrderEnabled,
        autoExitEnabled: verifiedValue.autoExitEnabled,
        killSwitchEnabled: verifiedValue.killSwitchEnabled,
        allowRealDomesticOrder: verifiedValue.allowRealDomesticOrder,
        allowRealOverseasOrder: verifiedValue.allowRealOverseasOrder,
      },
      message: enable
        ? '안전모드 활성화: 자동매수/자동청산/실전주문 모두 차단됨'
        : '안전모드 비활성화: 자동매수/자동청산 재개 (단, 실전주문은 여전히 차단)',
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `안전모드 토글 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
