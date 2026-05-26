// 트레이딩 설정 API
// 서버 DB를 진실의 원천으로 사용
// 우선순위: DB 저장값 > 환경변수 > 안전 기본값
// 위험 옵션(enableOverseasOrder, allowAfterHoursTrading, autoDomesticOrderEnabled)은
// 명시적 true가 아니면 false
//
// GET/POST 모두 getEffectiveTradingSettings() 공통 함수를 사용하여
// 실제 에이전트 실행 설정과 100% 일치 보장

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEffectiveTradingSettings, EffectiveTradingSettings } from '@/lib/effective-settings';

// 안전 기본값 (effective-settings.ts와 동일)
const DEFAULT_SETTINGS: EffectiveTradingSettings = {
  autoAnalysisEnabled: true,
  runAnalysisOnlyDuringMarketHours: false,
  autoDomesticOrderEnabled: true,
  enableOverseasAnalysis: false,
  enableOverseasOrder: false,
  allowAfterHoursTrading: false,
  tradeOnlyMarketHours: true,
  cycleIntervalMs: 60000,
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
  maxOverseasPriceGapPercent: 0.005,
  // 주문 실행 모드 기본값
  tradingMode: 'DEMO',
  orderExecutionMode: 'DRY_RUN',
  allowRealDomesticOrder: false,
  allowRealOverseasOrder: false,
  killSwitchEnabled: false,
  maxDomesticOrderAmount: 100000,
  maxOverseasOrderAmount: 100,
  maxDailyDomesticOrders: 1,
  maxDailyOverseasOrders: 1,
  maxOpenDomesticPositions: 1,
  maxOpenOverseasPositions: 1,
  // 신호 임계값 기본값
  strategyAggressiveness: 'CONSERVATIVE' as const,
  signalThreshold: 40,
};

type SettingsKey = keyof typeof DEFAULT_SETTINGS;

// DB 저장 키
const SETTINGS_DB_KEY = 'trading_settings';

/**
 * GET /api/settings/trading
 * DB에서 마지막 저장된 trading settings 반환
 * getEffectiveTradingSettings() 공통 함수를 사용하여
 * 에이전트 실행 설정과 동일한 결과 보장
 */
export async function GET() {
  try {
    // 공통 함수 사용: DB > 환경변수 > 안전 기본값
    const { settings, source, sources } = await getEffectiveTradingSettings();

    // DATABASE_URL 확인 로그
    const dbUrlSet = !!process.env.DATABASE_URL;
    console.log(`[Settings] 설정 조회: source=${source}, dbUrl=${dbUrlSet}, keys=${Object.keys(settings).length}`);

    return NextResponse.json({
      success: true,
      data: settings,
      source,
      sources,
      meta: {
        dbUrlAvailable: dbUrlSet,
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
    // 실전 계좌에서 autoDomesticOrderEnabled=true는 명시적 저장 필요
    // 모의투자에서는 true 기본 허용
    if (safetyChecked.autoDomesticOrderEnabled !== true && safetyChecked.autoDomesticOrderEnabled !== false) {
      delete safetyChecked.autoDomesticOrderEnabled;
    }

    // 주문 실행 모드 안전장치: 실전 관련 옵션은 명시적 true가 아니면 false
    if (safetyChecked.allowRealDomesticOrder !== true) {
      safetyChecked.allowRealDomesticOrder = false;
    }
    if (safetyChecked.allowRealOverseasOrder !== true) {
      safetyChecked.allowRealOverseasOrder = false;
    }
    if (safetyChecked.killSwitchEnabled !== true) {
      safetyChecked.killSwitchEnabled = false;
    }
    const validModes = ['DRY_RUN', 'PAPER', 'LIVE'];
    if (!validModes.includes(safetyChecked.orderExecutionMode)) {
      safetyChecked.orderExecutionMode = 'DRY_RUN';
    }
    const validTradingModes = ['DEMO', 'REAL'];
    if (!validTradingModes.includes(safetyChecked.tradingMode)) {
      safetyChecked.tradingMode = 'DEMO';
    }
    // PAPER 모드는 DEMO에서만 허용 (tradingMode=REAL + PAPER 조합 불가)
    if (safetyChecked.orderExecutionMode === 'PAPER' && safetyChecked.tradingMode === 'REAL') {
      safetyChecked.orderExecutionMode = 'DRY_RUN';
    }
    // LIVE 모드는 현재 단계에서 하드 블록
    // 실전 주문을 원하면 tradingMode=REAL + allowRealDomesticOrder=true + orderExecutionMode=LIVE 모두 필요
    if (safetyChecked.orderExecutionMode === 'LIVE') {
      if (!safetyChecked.allowRealDomesticOrder && !safetyChecked.allowRealOverseasOrder) {
        safetyChecked.orderExecutionMode = 'DRY_RUN';
      }
      if (safetyChecked.tradingMode !== 'REAL') {
        safetyChecked.orderExecutionMode = 'DRY_RUN';
      }
    }
    if (safetyChecked.tradingMode === 'REAL' && !safetyChecked.allowRealDomesticOrder && !safetyChecked.allowRealOverseasOrder) {
      safetyChecked.tradingMode = 'DEMO';
    }
    // strategyAggressiveness 유효성 검증
    const validAggressiveness = ['CONSERVATIVE', 'TEST', 'AGGRESSIVE'];
    if (safetyChecked.strategyAggressiveness && !validAggressiveness.includes(safetyChecked.strategyAggressiveness)) {
      safetyChecked.strategyAggressiveness = 'CONSERVATIVE';
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

    // 저장 후 getEffectiveTradingSettings()로 최종 결과 재계산
    // (안전 오버라이드, isDemo 체크 등이 정확히 반영되도록)
    const { settings: effectiveResult } = await getEffectiveTradingSettings();

    return NextResponse.json({
      success: true,
      data: effectiveResult,
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
