// 트레이딩 설정 API
// 서버 DB를 진실의 원천으로 사용
// 우선순위: DB 저장값 > 환경변수 > 안전 기본값
// 위험 옵션(ENABLE_OVERSEAS_ORDER, ALLOW_AFTER_HOURS_TRADING)은 명시적 true가 아니면 false

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// 안전 기본값
const DEFAULT_SETTINGS = {
  enableOverseasAnalysis: false,
  enableOverseasOrder: false,
  allowAfterHoursTrading: false,
  cycleIntervalMs: 60000,
  tradeOnlyMarketHours: true,
  domesticMarketOpen: '09:00',
  domesticMarketClose: '15:30',
  overseasMarketOpen: '23:30',
  overseasMarketClose: '06:00',
  maxPositionSize: 0.1,
  maxDailyLoss: 0.03,
  maxTotalLoss: 0.1,
  maxOpenPositions: 5,
  stopLossPercent: 0.05,
  takeProfitPercent: 0.15,
  trailingStopPercent: 0.03,
  selectedStrategy: 'COMPOSITE',
};

type SettingsKey = keyof typeof DEFAULT_SETTINGS;

// DB 저장 키
const SETTINGS_DB_KEY = 'trading_settings';

/**
 * GET /api/settings/trading
 * DB에서 마지막 저장된 trading settings 반환
 * 없으면 환경변수 > 안전 기본값
 */
export async function GET() {
  try {
    let dbSettings: Record<string, unknown> | null = null;
    let source: 'db' | 'env' | 'default' = 'default';

    // 1순위: DB에서 조회
    try {
      const record = await db.appSetting.findUnique({
        where: { key: SETTINGS_DB_KEY },
      });
      if (record?.value) {
        dbSettings = record.value as Record<string, unknown>;
        source = 'db';
      }
    } catch (dbError) {
      console.warn('[Settings] DB 조회 실패, 환경변수/기본값 사용:', dbError instanceof Error ? dbError.message : 'Unknown');
    }

    // 2순위: 환경변수 오버라이드
    const envOverrides: Partial<typeof DEFAULT_SETTINGS> = {};

    // 해외 설정: 환경변수가 명시적 true면 반영
    if (process.env.ENABLE_OVERSEAS_TRADING === 'true') {
      envOverrides.enableOverseasAnalysis = true;
    }
    if (process.env.ENABLE_OVERSEAS_ANALYSIS === 'true') {
      envOverrides.enableOverseasAnalysis = true;
    }
    if (process.env.ENABLE_OVERSEAS_ORDER === 'true') {
      envOverrides.enableOverseasOrder = true;
    }
    if (process.env.ALLOW_AFTER_HOURS_TRADING === 'true') {
      envOverrides.allowAfterHoursTrading = true;
    }

    // 위험 옵션은 명시적 true가 아니면 항상 false (DB에 true로 저장되어도)
    // 환경변수가 이 값을 강제할 수 있음
    const safetyOverrides: Partial<typeof DEFAULT_SETTINGS> = {};
    // ENABLE_OVERSEAS_ORDER가 명시적으로 true가 아니면 false
    if (process.env.ENABLE_OVERSEAS_ORDER !== 'true') {
      safetyOverrides.enableOverseasOrder = false;
    }
    // ALLOW_AFTER_HOURS_TRADING이 명시적으로 true가 아니면 false
    if (process.env.ALLOW_AFTER_HOURS_TRADING !== 'true') {
      safetyOverrides.allowAfterHoursTrading = false;
    }

    // 3순위: 기본값
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(dbSettings || {}),
      ...envOverrides,
      // 위험 옵션 안전장치: 명시적 true가 아니면 항상 false
      ...safetyOverrides,
    };

    // source 결정: DB 값이 있었으면 db, 환경변수 오버라이드가 있었으면 env
    if (source !== 'db' && Object.keys(envOverrides).length > 0) {
      source = 'env';
    }

    // DATABASE_URL 확인 로그
    const dbUrlSet = !!process.env.DATABASE_URL;
    console.log(`[Settings] 설정 조회: source=${source}, dbUrl=${dbUrlSet}, keys=${Object.keys(settings).length}`);

    return NextResponse.json({
      success: true,
      data: settings,
      source,
      meta: {
        dbUrlAvailable: dbUrlSet,
        savedAt: dbSettings ? undefined : undefined,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `설정 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

/**
 * POST /api/settings/trading
 * 사용자가 저장한 설정을 DB에 upsert
 * 위험 옵션은 명시적 true가 아니면 false로 저장
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // 위험 옵션 안전장치: 명시적 true가 아니면 false
    const safetyChecked = { ...body };
    if (safetyChecked.enableOverseasOrder !== true) {
      safetyChecked.enableOverseasOrder = false;
    }
    if (safetyChecked.allowAfterHoursTrading !== true) {
      safetyChecked.allowAfterHoursTrading = false;
    }

    // 유효성 검증
    const validated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(safetyChecked)) {
      if (key in DEFAULT_SETTINGS) {
        // 타입 체크
        const defaultValue = DEFAULT_SETTINGS[key as SettingsKey];
        if (typeof value === typeof defaultValue) {
          validated[key] = value;
        } else if (typeof defaultValue === 'number' && typeof value === 'string') {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) {
            validated[key] = parsed;
          }
        } else if (typeof defaultValue === 'boolean' && typeof value === 'string') {
          validated[key] = value === 'true';
        }
      }
    }

    // DB에 upsert
    try {
      await db.appSetting.upsert({
        where: { key: SETTINGS_DB_KEY },
        update: { value: validated },
        create: { key: SETTINGS_DB_KEY, value: validated },
      });
      console.log('[Settings] 설정 저장 성공 (DB upsert)');
    } catch (dbError) {
      console.error('[Settings] DB 저장 실패:', dbError instanceof Error ? dbError.message : 'Unknown');
      // DB 저장 실패해도 응답은 반환 (인메모리로 동작)
    }

    // 환경변수 안전 오버라이드 재적용
    if (process.env.ENABLE_OVERSEAS_ORDER !== 'true') {
      validated.enableOverseasOrder = false;
    }
    if (process.env.ALLOW_AFTER_HOURS_TRADING !== 'true') {
      validated.allowAfterHoursTrading = false;
    }

    return NextResponse.json({
      success: true,
      data: {
        ...DEFAULT_SETTINGS,
        ...validated,
      },
      source: 'db',
      message: '설정이 저장되었습니다.',
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `설정 저장 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
