// 에이전트 상태 조회 라우트
// 서버 스케줄러 상태 + 에이전트 상태 + 배포 버전 정보 통합
// effectiveSettings + runtimeDecision으로 실제 실행 상태 명확히 표시

import { NextResponse } from 'next/server';
import { getAgentStatus, getAgentLogs } from '@/lib/trading-agent';
import { getSchedulerStatus } from '@/lib/agent-scheduler';
import { getEffectiveTradingSettings, computeRuntimeDecision, AGGRESSIVENESS_THRESHOLDS, type StrategyAggressiveness } from '@/lib/effective-settings';
import { getOverseasMarketInfo, isUSDST, getCurrentKSTString, getCurrentETString } from '@/lib/market-hours';
import { getDomesticSession } from '@/lib/agent-scheduler';
import { getAllAppSettings, getAppSetting } from '@/lib/prisma';
import { db } from '@/lib/db';
import { getEnvDiagnostics, getGitVersionInfo } from '@/lib/env-diagnostics';
import { getKisEnvDiagnostics } from '@/lib/kis-env-diagnostics';
import { getKisLastError } from '@/lib/kis-api';

export async function GET() {
  try {
    // 에이전트 상태
    const agentStatus = getAgentStatus();
    const recentLogs = getAgentLogs(30);

    // 서버 스케줄러 상태
    const schedulerStatus = await getSchedulerStatus();

    // 배포 버전 정보 (Railway 환경변수 + 로컬 git fallback)
    const gitInfo = await getGitVersionInfo();
    const versionInfo = {
      gitCommitSha: gitInfo.gitCommitSha,
      gitBranch: gitInfo.gitBranch,
      appVersion: process.env.APP_VERSION || null,
      railwayServiceId: process.env.RAILWAY_SERVICE_ID || null,
      railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
      nodeEnv: process.env.NODE_ENV || 'development',
      runtime: process.env.RAILWAY_SERVICE_ID ? 'railway' : 'local',
    };

    // 환경변수 로딩 진단 (민감값 없이 boolean만)
    const envDiagnostics = getEnvDiagnostics();

    // KIS 진단 (공통 판정 함수 — local-health와 동일 기준)
    const kisDiag = getKisEnvDiagnostics();

    // 실제 실행 설정 + 런타임 판단
    const { settings: effectiveSettings, source: settingsSource, sources: settingsSources, _safety } = await getEffectiveTradingSettings();
    const runtimeDecision = computeRuntimeDecision(effectiveSettings);

    // DB 원본 설정 값 (안전 보정 전) 조회 — 안전 진단용
    let dbOriginalAutoDomesticOrder: boolean | null = null;
    let dbOriginalKillSwitch: boolean | null = null;
    try {
      const dbRecord = await getAppSetting('trading_settings');
      if (dbRecord?.value && typeof dbRecord.value === 'object') {
        const v = dbRecord.value as Record<string, unknown>;
        dbOriginalAutoDomesticOrder = typeof v.autoDomesticOrderEnabled === 'boolean' ? v.autoDomesticOrderEnabled : null;
        dbOriginalKillSwitch = typeof v.killSwitchEnabled === 'boolean' ? v.killSwitchEnabled : null;
      }
    } catch { /* ignore */ }

    const safetyDiagnostics = {
      effectiveSafetyMode: _safety.allowStrategyTestOrder ? 'TEST_ALLOWED' as const : 'SAFE_LOCKED' as const,
      allowStrategyTestOrder: _safety.allowStrategyTestOrder,
      dbRequestedStrategyAggressiveness: _safety.dbRequestedStrategyAggressiveness,
      effectiveStrategyAggressiveness: effectiveSettings.strategyAggressiveness,
      dbAutoDomesticOrderEnabled: dbOriginalAutoDomesticOrder,
      effectiveAutoDomesticOrderEnabled: effectiveSettings.autoDomesticOrderEnabled,
      dbKillSwitchEnabled: dbOriginalKillSwitch,
      effectiveKillSwitchEnabled: effectiveSettings.killSwitchEnabled,
      canPlaceDomesticOrderNow: runtimeDecision.canPlaceDomesticOrderNow,
      safetyBlockedReasons: _safety.safetyBlockedReasons,
    };

    // DB에서 영속 로그 조회 (최근 30개, 오늘 KST 이후만)
    let dbLogs: Array<{
      id: string;
      type: string;
      market: string;
      message: string;
      details: string | null;
      createdAt: string;
    }> = [];
    try {
      // KST 오늘 00:00:00 = UTC 전날 15:00:00
      const now = new Date();
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstNow = new Date(now.getTime() + kstOffset);
      const kstDateStr = kstNow.toISOString().slice(0, 10);
      const startOfTodayKST = new Date(`${kstDateStr}T00:00:00+09:00`);

      const logs = await db.agentLog.findMany({
        where: { createdAt: { gte: startOfTodayKST } },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      dbLogs = logs.map((l: any) => ({
        id: l.id,
        type: l.type,
        market: l.market,
        message: l.message,
        details: l.details,
        createdAt: l.createdAt?.toISOString?.() || l.createdAt,
      }));
    } catch {
      // DB 로그 조회 실패 시 메모리 로그 사용
    }

    // 메모리 로그와 DB 로그 병합 (중복 제거)
    const memoryLogIds = new Set(recentLogs.map(l => l.message + l.type));
    const mergedLogs = [
      ...recentLogs.map(log => ({
        id: log.id,
        timestamp: log.timestamp.toISOString(),
        type: log.type,
        market: log.market,
        message: log.message,
        details: log.details || null,
      })),
      ...dbLogs.filter(l => !memoryLogIds.has(l.message + l.type)).map(l => ({
        id: l.id,
        timestamp: l.createdAt,
        type: l.type,
        market: l.market,
        message: l.message,
        details: l.details,
      })),
    ].slice(0, 50);

    // ── 데이터 계층 명확화 (v3 원칙: Position=원장, TradeHistory=체결기록) ──
    const dataLayerPrinciple = {
      position: 'LEDGER — KIS 잔고 기준 원장. 보유 포지션의 단일 진실 공급원. resync로만 갱신.',
      tradeHistory: 'AUDIT_TRAIL — 체결/주문/차단 기록. 삭제 금지(immutable). 성과 집계 원본.',
      agentLog: 'RUNTIME_LOG — 사이클 실행 로그. 진단/디버깅용. 날짜 필터 적용됨.',
      signalGeneration: 'INTENT_ONLY — 전략은 Signal만 생성. 주문은 Rule Engine 검증 후 실행.',
      note: 'TradeHistory로 Position을 추론하지 마세요. Position(원장)이 항상 우선입니다.',
    };

    return NextResponse.json({
      success: true,
      data: {
        // ── 데이터 계층 (v3 설계 원칙 참고) ──
        dataLayer: dataLayerPrinciple,

        // 기본 에이전트 상태
        isRunning: agentStatus.isRunning,
        currentSessionId: agentStatus.currentSessionId,
        lastCycleTime: agentStatus.lastCycleTime?.toISOString() || null,
        totalCycles: agentStatus.totalCycles,
        totalTrades: agentStatus.totalTrades,
        dailyPnL: agentStatus.dailyPnL,
        // ── 주문 카운트 분리 ──
        ordersAttempted: agentStatus.ordersAttempted,
        ordersSubmitted: agentStatus.ordersSubmitted,
        ordersFilled: agentStatus.ordersFilled,
        ordersBlocked: agentStatus.ordersBlocked,
        ordersFailed: agentStatus.ordersFailed,
        // ── 거래내역 저장 실패 진단 ──
        tradeHistoryDiagnostics: {
          saveFailureCount: agentStatus.tradeHistorySaveFailures.length,
          recentFailures: agentStatus.tradeHistorySaveFailures.slice(-5).map(f => ({
            time: f.time.toISOString(),
            market: f.market,
            stockCode: f.stockCode,
            error: f.error,
          })),
          warning: agentStatus.tradeHistorySaveFailures.length > 0
            ? `${agentStatus.tradeHistorySaveFailures.length}건의 거래내역 저장 실패 — DB 연결 또는 스키마를 확인하세요. ` +
              `스키마 동기화 누락 의심 시 POST /api/system/schema-sync {force:true} 실행`
            : null,
        },
        lastCycleSummary: agentStatus.lastCycleResult ? {
          stocksAnalyzed: agentStatus.lastCycleResult.stocksAnalyzed,
          signalsGenerated: agentStatus.lastCycleResult.signalsGenerated,
          ordersPlaced: agentStatus.lastCycleResult.ordersPlaced,
          positionsMonitored: agentStatus.lastCycleResult.positionsMonitored,
          exitsExecuted: agentStatus.lastCycleResult.exitsExecuted,
          duration: agentStatus.lastCycleResult.endTime.getTime() - agentStatus.lastCycleResult.startTime.getTime(),
          domesticSuccess: agentStatus.lastCycleResult.domesticSuccess,
          domesticFailed: agentStatus.lastCycleResult.domesticFailed,
          overseasSuccess: agentStatus.lastCycleResult.overseasSuccess,
          overseasFailed: agentStatus.lastCycleResult.overseasFailed,
          zeroAnalysisReason: agentStatus.lastCycleResult.zeroAnalysisReason,
          // ── KIS 호출 단계별 카운트 ──
          candleSuccess: agentStatus.lastCycleResult.candleSuccess,
          candleFailed: agentStatus.lastCycleResult.candleFailed,
          priceSuccess: agentStatus.lastCycleResult.priceSuccess,
          priceFailed: agentStatus.lastCycleResult.priceFailed,
          balanceSuccess: agentStatus.lastCycleResult.balanceSuccess,
          balanceFailed: agentStatus.lastCycleResult.balanceFailed,
          // ── 진단 필드 ──
          uiSignalsCount: agentStatus.lastCycleResult.uiSignalsCount,
          executableSignalsCount: agentStatus.lastCycleResult.executableSignalsCount,
          signalsBlockedReasons: agentStatus.lastCycleResult.signalsBlockedReasons,
          topBuyCandidates: agentStatus.lastCycleResult.topBuyCandidates,
          signalThreshold: agentStatus.lastCycleResult.signalThreshold,
          weakSignalThreshold: agentStatus.lastCycleResult.weakSignalThreshold,
          minConfidenceThreshold: agentStatus.lastCycleResult.minConfidenceThreshold,
          strategyAggressiveness: agentStatus.lastCycleResult.strategyAggressiveness,
          positionQueryFailed: agentStatus.lastCycleResult.positionQueryFailed,
          positionQueryFailedReason: agentStatus.lastCycleResult.positionQueryFailedReason,
          forceTestSignalUsed: agentStatus.lastCycleResult.forceTestSignalUsed,
        } : null,

        // 서버 스케줄러 상태
        scheduler: {
          isSchedulerRunning: schedulerStatus.isSchedulerRunning,
          schedulerMode: schedulerStatus.schedulerMode,
          isCycleRunning: schedulerStatus.isCycleRunning,
          errorCount: schedulerStatus.errorCount,
          startedAt: schedulerStatus.startedAt?.toISOString() || null,
          lastCycleAt: schedulerStatus.lastCycleAt?.toISOString() || null,
          nextCycleAt: schedulerStatus.nextCycleAt?.toISOString() || null,
          isMarketOpen: schedulerStatus.isMarketOpen,
          config: schedulerStatus.config,
          totalCycles: schedulerStatus.totalCycles,
          totalTrades: schedulerStatus.totalTrades,
          currentKST: schedulerStatus.currentKST,
          domesticSession: schedulerStatus.domesticSession,
          overseasMarketInfo: schedulerStatus.overseasMarketInfo,
        },

        // 해외(미국) 장시간 ET 기반 정보
        // KST 요일이 아닌 ET 요일로 판단, 서머타임 자동 반영
        overseasMarket: {
          currentKST: getCurrentKSTString(),
          currentET: getCurrentETString(),
          isUSDST: isUSDST(),
          isOverseasMarketOpen: schedulerStatus.overseasMarketInfo.isOpen,
          overseasMarketOpenKST: schedulerStatus.overseasMarketInfo.overseasMarketOpenKST,
          overseasMarketCloseKST: schedulerStatus.overseasMarketInfo.overseasMarketCloseKST,
          overseasSessionLabel: schedulerStatus.overseasMarketInfo.overseasSessionLabel,
          etDate: schedulerStatus.overseasMarketInfo.etDate,
          etDayOfWeek: schedulerStatus.overseasMarketInfo.etDayOfWeek,
          blockedReason: schedulerStatus.overseasMarketInfo.blockedReason,
        },

        // 배포 버전 정보
        version: versionInfo,

        // 스키마 동기화 상태 (런타임 보장)
        schemaSync: (() => {
          try {
            // 동적 import로 순환 의존성 방지
            const schemaSyncModule = require('@/lib/schema-sync');
            return schemaSyncModule.getSchemaSyncStatus();
          } catch (_e) {
            return { attempted: false, success: false, error: 'module not loaded', syncedAt: null, syncedColumns: [] };
          }
        })(),

        // 실제 실행 설정 (에이전트와 100% 동일한 소스)
        effectiveSettings: {
          autoAnalysisEnabled: effectiveSettings.autoAnalysisEnabled,
          runAnalysisOnlyDuringMarketHours: effectiveSettings.runAnalysisOnlyDuringMarketHours,
          autoDomesticOrderEnabled: effectiveSettings.autoDomesticOrderEnabled,
          enableOverseasAnalysis: effectiveSettings.enableOverseasAnalysis,
          enableOverseasOrder: effectiveSettings.enableOverseasOrder,
          allowAfterHoursTrading: effectiveSettings.allowAfterHoursTrading,
          tradeOnlyMarketHours: effectiveSettings.tradeOnlyMarketHours,
          cycleIntervalMs: effectiveSettings.cycleIntervalMs,
          domesticMarketOpen: effectiveSettings.domesticMarketOpen,
          domesticMarketClose: effectiveSettings.domesticMarketClose,
          overseasMarketOpen: effectiveSettings.overseasMarketOpen,
          overseasMarketClose: effectiveSettings.overseasMarketClose,
          riskSummary: {
            maxPositionSize: effectiveSettings.maxPositionSize,
            maxDailyLoss: effectiveSettings.maxDailyLoss,
            maxTotalLoss: effectiveSettings.maxTotalLoss,
            maxOpenPositions: effectiveSettings.maxOpenPositions,
            stopLossPercent: effectiveSettings.stopLossPercent,
            takeProfitPercent: effectiveSettings.takeProfitPercent,
            trailingStopPercent: effectiveSettings.trailingStopPercent,
            maxOverseasPriceGapPercent: effectiveSettings.maxOverseasPriceGapPercent,
          },
          selectedStrategy: effectiveSettings.selectedStrategy,
          // 주문 실행 모드
          tradingMode: effectiveSettings.tradingMode,
          orderExecutionMode: effectiveSettings.orderExecutionMode,
          allowRealDomesticOrder: effectiveSettings.allowRealDomesticOrder,
          allowRealOverseasOrder: effectiveSettings.allowRealOverseasOrder,
          killSwitchEnabled: effectiveSettings.killSwitchEnabled,
          autoExitEnabled: effectiveSettings.autoExitEnabled,
          maxDomesticOrderAmount: effectiveSettings.maxDomesticOrderAmount,
          maxOverseasOrderAmount: effectiveSettings.maxOverseasOrderAmount,
          maxDailyDomesticOrders: effectiveSettings.maxDailyDomesticOrders,
          maxDailyOverseasOrders: effectiveSettings.maxDailyOverseasOrders,
          maxOpenDomesticPositions: effectiveSettings.maxOpenDomesticPositions,
          maxOpenOverseasPositions: effectiveSettings.maxOpenOverseasPositions,
          // ── 전략 공격성 설정 ──
          strategyAggressiveness: effectiveSettings.strategyAggressiveness,
          signalThreshold: effectiveSettings.signalThreshold,
          weakSignalThreshold: effectiveSettings.weakSignalThreshold,
          minConfidenceThreshold: effectiveSettings.minConfidenceThreshold,
          // ── v2 고급 전략 필드 (STRATEGY_TEST / AGGRESSIVE_STRATEGY에서 활성화) ──
          accountRiskPercent: effectiveSettings.accountRiskPercent,
          useATRStop: effectiveSettings.useATRStop,
          partialTakeProfit: effectiveSettings.partialTakeProfit,
          indexFilter: effectiveSettings.indexFilter,
        },
        settingsSource,
        settingsSources,

        // ── 신호 진단 요약 ──
        signalDiagnostics: {
          strategyAggressiveness: effectiveSettings.strategyAggressiveness,
          signalThreshold: effectiveSettings.signalThreshold,
          weakSignalThreshold: effectiveSettings.weakSignalThreshold,
          minConfidenceThreshold: effectiveSettings.minConfidenceThreshold,
          // 마지막 사이클 결과에서 진단값 (없으면 빈 값)
          uiSignalsCount: agentStatus.lastCycleResult?.uiSignalsCount ?? null,
          executableSignalsCount: agentStatus.lastCycleResult?.executableSignalsCount ?? null,
          signalsBlockedReasons: agentStatus.lastCycleResult?.signalsBlockedReasons ?? [],
          topBuyCandidates: agentStatus.lastCycleResult?.topBuyCandidates ?? [],
          positionQueryFailed: agentStatus.lastCycleResult?.positionQueryFailed ?? false,
          positionQueryFailedReason: agentStatus.lastCycleResult?.positionQueryFailedReason ?? null,
          forceTestSignalUsed: agentStatus.lastCycleResult?.forceTestSignalUsed ?? false,
          // 주문 차단 사유 (런타임 판단 기준)
          orderBlockedReason: !runtimeDecision.canPlaceDomesticOrderNow
            ? runtimeDecision.domesticOrderBlockedReason
            : effectiveSettings.killSwitchEnabled
              ? 'killSwitchEnabled=true'
              : effectiveSettings.orderExecutionMode === 'DRY_RUN'
                ? 'DRY_RUN 모드 (주문 미실행)'
                : null,
        },

        // 런타임 판단 (현재 시각 기준 즉시 상태)
        runtimeDecision: {
          canRunAnalysisNow: runtimeDecision.canRunAnalysisNow,
          canPlaceDomesticOrderNow: runtimeDecision.canPlaceDomesticOrderNow,
          canPlaceOverseasOrderNow: runtimeDecision.canPlaceOverseasOrderNow,
          analysisBlockedReason: runtimeDecision.analysisBlockedReason,
          domesticOrderBlockedReason: runtimeDecision.domesticOrderBlockedReason,
          overseasOrderBlockedReason: runtimeDecision.overseasOrderBlockedReason,
        },

        // ── 안전 진단 ──
        safetyDiagnostics,

        // ── 차단 원인 통합 요약 ──
        currentBlockingSummary: (() => {
          const domesticSession = getDomesticSession();
          const canAnalyze = runtimeDecision.canRunAnalysisNow;
          const canGenerateSignal = effectiveSettings.strategyAggressiveness !== 'CONSERVATIVE'
            || (agentStatus.lastCycleResult?.uiSignalsCount ?? 0) > 0;
          const canSendOrder = runtimeDecision.canPlaceDomesticOrderNow
            && effectiveSettings.orderExecutionMode !== 'DRY_RUN'
            && !effectiveSettings.killSwitchEnabled;
          const reasons: string[] = [];

          // 1. 장시간 차단
          if (!runtimeDecision.canPlaceDomesticOrderNow) {
            reasons.push(`현재 ${domesticSession.label} — 신규 매수 주문 차단 (정규장 09:00~15:10에만 가능)`);
          }

          // 2. 전략 공격성에 의한 신호 부재
          if (effectiveSettings.strategyAggressiveness === 'CONSERVATIVE') {
            const thresholds = AGGRESSIVENESS_THRESHOLDS.CONSERVATIVE;
            reasons.push(`strategyAggressiveness=CONSERVATIVE → signalThreshold=${thresholds.signalThreshold}, minConfidence=${thresholds.minConfidence}% (TEST 모드 전환 권장)`);
          }

          // 3. 주문 모드 차단
          if (effectiveSettings.orderExecutionMode === 'DRY_RUN') {
            reasons.push('orderExecutionMode=DRY_RUN — 실제 주문 차단 (PAPER 모드로 전환 필요)');
          }

          // 4. 킬스위치
          if (effectiveSettings.killSwitchEnabled) {
            reasons.push('killSwitchEnabled=true — 모든 주문 차단');
          }

          // 5. 신호 0개
          if ((agentStatus.lastCycleResult?.signalsGenerated ?? 0) === 0) {
            reasons.push(`signalsGenerated=0 — 매수 신호 생성 없음`);
          }

          // 6. 포지션 조회 실패
          if (agentStatus.lastCycleResult?.positionQueryFailed) {
            reasons.push('포지션 조회 실패 — 주문 안전을 위해 차단 (PAPER+DEMO는 예외)');
          }

          return {
            canAnalyze,
            canGenerateSignal,
            canSendOrder,
            reasons,
            currentSession: domesticSession.session,
            currentSessionLabel: domesticSession.label,
            strategyAggressiveness: effectiveSettings.strategyAggressiveness,
            signalThreshold: effectiveSettings.signalThreshold,
            minConfidenceThreshold: effectiveSettings.minConfidenceThreshold,
            orderExecutionMode: effectiveSettings.orderExecutionMode,
            signalsGenerated: agentStatus.lastCycleResult?.signalsGenerated ?? 0,
            ordersPlaced: agentStatus.lastCycleResult?.ordersPlaced ?? 0,
            // ── testModeApplied: PAPER+TEST가 올바르게 적용되었는지 ──
            testModeApplied: effectiveSettings.orderExecutionMode === 'PAPER'
              && (effectiveSettings.strategyAggressiveness === 'PIPELINE_TEST' || effectiveSettings.strategyAggressiveness === 'STRATEGY_TEST'),
            // ── testModeApplied 상세 진단 ──
            testModeDiagnostics: {
              orderExecutionMode: effectiveSettings.orderExecutionMode,
              strategyAggressiveness: effectiveSettings.strategyAggressiveness,
              signalThreshold: effectiveSettings.signalThreshold,
              weakSignalThreshold: effectiveSettings.weakSignalThreshold,
              minConfidenceThreshold: effectiveSettings.minConfidenceThreshold,
              aggressivenessSource: settingsSources.strategyAggressiveness,
              isTestMode: effectiveSettings.strategyAggressiveness === 'PIPELINE_TEST' || effectiveSettings.strategyAggressiveness === 'STRATEGY_TEST',
              isPaperMode: effectiveSettings.orderExecutionMode === 'PAPER',
              isDemoMode: effectiveSettings.tradingMode === 'DEMO',
              expectedThresholds: (effectiveSettings.strategyAggressiveness === 'PIPELINE_TEST' || effectiveSettings.strategyAggressiveness === 'STRATEGY_TEST')
                ? { signalThreshold: 30, weakSignalThreshold: 25, minConfidenceThreshold: 30 }
                : null,
            },
            // ── PAPER 모드인데 CONSERVATIVE인 경우 강한 경고 ──
            paperConservativeWarning: effectiveSettings.orderExecutionMode === 'PAPER'
              && effectiveSettings.strategyAggressiveness === 'CONSERVATIVE'
              ? 'PAPER 모드는 켜졌지만 신호 기준은 보수 모드입니다. TEST 모드로 전환해야 모의주문 테스트가 가능합니다.'
              : null,
          };
        })(),

        // 로그
        recentLogs: mergedLogs,

        // KIS 진단 (configured/missingKeys/baseUrlType/allowRealFallback)
        // 마지막 사이클 결과에서 분석 스킵 여부도 함께 표시
        kisDiagnostics: {
          configured: kisDiag.kisConfigured,
          missingKeys: kisDiag.missingKeys,
          baseUrlType: kisDiag.baseUrlType,
          allowRealFallback: kisDiag.allowRealFallback,
          isDemo: kisDiag.isDemo,
          analysisSkipped: !kisDiag.kisConfigured,
          skipReason: !kisDiag.kisConfigured ? 'KIS 설정 불완전' : null,
          ...(getKisLastError() ? { lastError: getKisLastError() } : {}),
        },
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `상태 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
