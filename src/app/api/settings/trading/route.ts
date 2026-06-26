// 트레이딩 설정 API
// 서버 DB를 진실의 원천으로 사용
// 우선순위: DB 저장값 > 환경변수 > 안전 기본값
// 위험 옵션(enableOverseasOrder, allowAfterHoursTrading, autoDomesticOrderEnabled)은
// 명시적 true가 아니면 false
//
// GET/POST 모두 getEffectiveTradingSettings() 공통 함수를 사용하여
// 실제 에이전트 실행 설정과 100% 일치 보장

import { NextRequest, NextResponse } from 'next/server';
import { getAppSetting, setAppSetting } from '@/lib/prisma';
import { getEffectiveTradingSettings, EffectiveTradingSettings } from '@/lib/effective-settings';

// 안전 기본값 (effective-settings.ts와 동일하게 보수 운용 기준으로 유지)
const DEFAULT_SETTINGS: EffectiveTradingSettings = {
  autoAnalysisEnabled: true,
  runAnalysisOnlyDuringMarketHours: false,
  autoDomesticOrderEnabled: false,
  enableOverseasAnalysis: false,
  enableOverseasOrder: false,
  allowAfterHoursTrading: false,
  tradeOnlyMarketHours: true,
  cycleIntervalMs: 120000,
  domesticMarketOpen: '09:00',
  domesticMarketClose: '15:30',
  overseasMarketOpen: '23:30',
  overseasMarketClose: '06:00',
  maxPositionSize: 0.1,
  maxDailyLoss: 0.03,
  maxTotalLoss: 0.1,
  maxOpenPositions: 3,
  stopLossPercent: 0.05,
  takeProfitPercent: 0.15,
  trailingStopPercent: 0.03,
  selectedStrategy: 'COMPOSITE',
  maxOverseasPriceGapPercent: 0.005,
  // 주문 실행 모드 기본값: DEMO/PAPER 환경에서도 주문은 명시적으로 켜기 전까지 차단
  tradingMode: 'DEMO',
  orderExecutionMode: 'DRY_RUN',
  allowRealDomesticOrder: false,
  allowRealOverseasOrder: false,
  killSwitchEnabled: true,
  autoExitEnabled: false,
  maxDomesticOrderAmount: 1000000,
  maxOverseasOrderAmount: 500,
  maxDailyDomesticOrders: 5,
  maxDailyOverseasOrders: 3,
  maxOpenDomesticPositions: 3,
  maxOpenOverseasPositions: 1,
  // 전략 공격성 기본값: STRATEGY_TEST가 아닌 CONSERVATIVE
  strategyAggressiveness: 'CONSERVATIVE',
  signalThreshold: 70,
  weakSignalThreshold: 55,
  minConfidenceThreshold: 65,
  // 고급 전략 설정 (strategyAggressiveness에 의해 자동 설정)
  accountRiskPercent: 0.25,
  useATRStop: false,
  partialTakeProfit: false,
  indexFilter: false,
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

    // 국내 자동매수는 기본 OFF. 명시적 true/false가 아닌 입력은 저장하지 않음.
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

    // killSwitch/autoExit은 안전 기본값을 우선한다.
    // 사용자가 명시적으로 값을 보낸 경우만 반영하되, 값이 없으면 killSwitch=true, autoExit=false로 저장한다.
    if (safetyChecked.killSwitchEnabled !== true && safetyChecked.killSwitchEnabled !== false) {
      safetyChecked.killSwitchEnabled = true;
    }
    if (safetyChecked.autoExitEnabled !== true && safetyChecked.autoExitEnabled !== false) {
      safetyChecked.autoExitEnabled = false;
    }

    const validModes = ['DRY_RUN', 'PAPER', 'LIVE'];
    if (!validModes.includes(safetyChecked.orderExecutionMode)) {
      safetyChecked.orderExecutionMode = 'DRY_RUN';
    }
    const validTradingModes = ['DEMO', 'REAL'];
    if (!validTradingModes.includes(safetyChecked.tradingMode)) {
      safetyChecked.tradingMode = 'DEMO';
    }
    if (safetyChecked.orderExecutionMode === 'LIVE' && !safetyChecked.allowRealDomesticOrder && !safetyChecked.allowRealOverseasOrder) {
      safetyChecked.orderExecutionMode = 'DRY_RUN';
    }
    if (safetyChecked.tradingMode === 'REAL' && !safetyChecked.allowRealDomesticOrder && !safetyChecked.allowRealOverseasOrder) {
      safetyChecked.tradingMode = 'DEMO';
    }

    // ── strategyAggressiveness 화이트리스트 검증 ──
    // orderExecutionMode와 동일하게 유효값이 아니면 기본값(CONSERVATIVE)으로 복구
    const validAggressiveness = ['CONSERVATIVE', 'PIPELINE_TEST', 'STRATEGY_TEST', 'AGGRESSIVE_STRATEGY'];
    if (safetyChecked.strategyAggressiveness && !validAggressiveness.includes(safetyChecked.strategyAggressiveness)) {
      console.warn('[Settings] strategyAggressiveness 무효값, CONSERVATIVE로 복구:', safetyChecked.strategyAggressiveness);
      safetyChecked.strategyAggressiveness = 'CONSERVATIVE';
    }
    if (!safetyChecked.strategyAggressiveness) {
      safetyChecked.strategyAggressiveness = 'CONSERVATIVE';
    }

    // 포지션 수 기준 통일: 국내 신규 BUY 기준은 maxOpenDomesticPositions=3을 기본으로 사용
    if (!Number.isFinite(Number(safetyChecked.maxOpenDomesticPositions)) || Number(safetyChecked.maxOpenDomesticPositions) <= 0) {
      safetyChecked.maxOpenDomesticPositions = 3;
    }
    if (!Number.isFinite(Number(safetyChecked.maxOpenPositions)) || Number(safetyChecked.maxOpenPositions) <= 0) {
      safetyChecked.maxOpenPositions = Number(safetyChecked.maxOpenDomesticPositions) || 3;
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
      } else {
        // DEFAULT_SETTINGS에 없는 키 — 무시하되 로그 남김
        console.warn('[Settings] 알 수 없는 설정 키 무시:', key, '=', value);
      }
    }

    // strategyAggressiveness가 validated에 들어갔는지 최종 확인
    if (safetyChecked.strategyAggressiveness && !validated.strategyAggressiveness) {
      console.error('[Settings] BUG: strategyAggressiveness가 검증 후 사라짐!', {
        original: safetyChecked.strategyAggressiveness,
        validatedKeys: Object.keys(validated),
      });
      // 강제 주입
      validated.strategyAggressiveness = safetyChecked.strategyAggressiveness;
    }

    // ── 계산된 임계값은 DB에 저장하지 않음 ──
    // signalThreshold, weakSignalThreshold, minConfidenceThreshold은
    // strategyAggressiveness에 의해 getEffectiveTradingSettings()에서 자동 계산됨
    // DB에 저장하면 strategyAggressiveness 변경 시 덮어쓰기가 안 됨
    delete validated.signalThreshold;
    delete validated.weakSignalThreshold;
    delete validated.minConfidenceThreshold;

    // ── 기존 DB 값과 병합 (merge) 후 저장 ──
    // 핵심 수정: 이전에는 validated만 저장해서 기존 필드가 모두 지워졌음
    // 이제는 기존 DB 값에 validated를 덮어쓰는 방식으로 병합
    try {
      // 1) 기존 DB 값 읽기 (직접 Prisma)
      const existingRecord = await getAppSetting(SETTINGS_DB_KEY);
      const existingValue = (existingRecord?.value && typeof existingRecord.value === 'object')
        ? existingRecord.value as Record<string, unknown>
        : {};

      // 2) 기존 값에 validated 덮어쓰기 (새 값이 우선)
      const merged = { ...existingValue, ...validated };

      // 안전 기본값을 저장 단계에서도 보강한다.
      merged.autoDomesticOrderEnabled = merged.autoDomesticOrderEnabled === true;
      merged.killSwitchEnabled = merged.killSwitchEnabled !== false;
      merged.autoExitEnabled = merged.autoExitEnabled === true ? true : false;
      merged.maxOpenDomesticPositions = Number(merged.maxOpenDomesticPositions) || 3;
      merged.maxOpenPositions = Number(merged.maxOpenDomesticPositions) || 3;
      merged.strategyAggressiveness = merged.strategyAggressiveness || 'CONSERVATIVE';

      // 3) 계산된 임계값이 병합 결과에 있으면 제거
      //    (strategyAggressiveness 변경 시 임계값이 덮어쓰기되지 않도록)
      delete merged.signalThreshold;
      delete merged.weakSignalThreshold;
      delete merged.minConfidenceThreshold;

      // ── strategyAggressiveness 명시적 보존 검증 ──
      // validated에 strategyAggressiveness가 있으면 merged에 반드시 있어야 함
      if (validated.strategyAggressiveness && !merged.strategyAggressiveness) {
        console.error('[Settings] BUG: strategyAggressiveness가 병합 후 사라짐!', {
          validatedAggressiveness: validated.strategyAggressiveness,
          mergedKeys: Object.keys(merged),
          mergedStrategyAggressiveness: merged.strategyAggressiveness,
        });
        merged.strategyAggressiveness = validated.strategyAggressiveness;
      }

      // 4) 직접 Prisma로 저장 (db.ts Proxy 우회)
      const saveOk = await setAppSetting(SETTINGS_DB_KEY, merged);
      if (!saveOk) {
        console.error('[Settings] setAppSetting 반환 false — 저장 실패');
      }

      // 5) Read-after-write 검증
      const savedRecord = await getAppSetting(SETTINGS_DB_KEY);
      const savedValue = (savedRecord?.value && typeof savedRecord.value === 'object')
        ? savedRecord.value as Record<string, unknown>
        : {};
      const savedAggressiveness = savedValue.strategyAggressiveness;
      if (validated.strategyAggressiveness && savedAggressiveness !== validated.strategyAggressiveness) {
        console.error('[Settings] DB 저장 후 검증 실패: strategyAggressiveness 불일치', {
          expected: validated.strategyAggressiveness,
          actual: savedAggressiveness,
          savedValueKeys: Object.keys(savedValue),
        });
        // 강제 재시도
        merged.strategyAggressiveness = validated.strategyAggressiveness;
        await setAppSetting(SETTINGS_DB_KEY, merged);
        console.log('[Settings] strategyAggressiveness 강제 재저장 완료');
      }

      console.log('[Settings] 설정 저장 성공 (직접 Prisma, merge)', {
        existingKeys: Object.keys(existingValue),
        newKeys: Object.keys(validated),
        mergedKeys: Object.keys(merged),
        strategyAggressiveness: merged.strategyAggressiveness,
        savedAggressiveness: (savedValue as Record<string, unknown>)?.strategyAggressiveness,
        mergedPreview: {
          orderExecutionMode: merged.orderExecutionMode,
          tradingMode: merged.tradingMode,
          strategyAggressiveness: merged.strategyAggressiveness,
          autoDomesticOrderEnabled: merged.autoDomesticOrderEnabled,
          killSwitchEnabled: merged.killSwitchEnabled,
        },
      });
    } catch (dbError) {
      console.error('[Settings] DB 저장 실패:', dbError instanceof Error ? dbError.message : 'Unknown');
    }

    // 저장 후 getEffectiveTradingSettings()로 최종 결과 재계산
    // (안전 오버라이드, isDemo 체크, strategyAggressiveness 기반 임계값 계산 등이 정확히 반영되도록)
    const { settings: effectiveResult, source: resultSource, sources: resultSources } = await getEffectiveTradingSettings();

    return NextResponse.json({
      success: true,
      data: effectiveResult,
      source: resultSource,
      sources: resultSources,
      message: '설정이 저장되었습니다.',
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `설정 저장 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
