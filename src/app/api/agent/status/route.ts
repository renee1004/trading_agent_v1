// 에이전트 상태 조회 라우트
// 서버 스케줄러 상태 + 에이전트 상태 + 배포 버전 정보 통합
// effectiveSettings + runtimeDecision으로 실제 실행 상태 명확히 표시

import { NextResponse } from 'next/server';
import { getAgentStatus, getAgentLogs } from '@/lib/trading-agent';
import { getSchedulerStatus } from '@/lib/agent-scheduler';
import { getEffectiveTradingSettings, computeRuntimeDecision, AGGRESSIVENESS_THRESHOLDS, type StrategyAggressiveness } from '@/lib/effective-settings';
import { getOverseasMarketInfo, isUSDST, getCurrentKSTString, getCurrentETString } from '@/lib/market-hours';
import { getDomesticSession } from '@/lib/agent-scheduler';
import { getAllAppSettings } from '@/lib/prisma';

export async function GET() {
  try {
    // 에이전트 상태
    const agentStatus = getAgentStatus();
    const recentLogs = getAgentLogs(30);

    // 서버 스케줄러 상태
    const schedulerStatus = await getSchedulerStatus();

    // 배포 버전 정보 (Railway 환경변수 + APP_VERSION)
    const versionInfo = {
      gitCommitSha: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      gitBranch: process.env.RAILWAY_GIT_BRANCH || null,
      appVersion: process.env.APP_VERSION || null,
      railwayServiceId: process.env.RAILWAY_SERVICE_ID || null,
      railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
      nodeEnv: process.env.NODE_ENV || 'development',
    };

    // 실제 실행 설정 + 런타임 판단
    const { settings: effectiveSettings, source: settingsSource, sources: settingsSources } = await getEffectiveTradingSettings();
    const runtimeDecision = computeRuntimeDecision(effectiveSettings);

    // DB에서 영속 로그 조회 (최근 30개) — 직접 Prisma 사용
    let dbLogs: Array<{
      id: string;
      type: string;
      market: string;
      message: string;
      details: string | null;
      createdAt: string;
    }> = [];
    try {
      const { prisma, ensurePrismaConnected } = await import('@/lib/prisma');
      await ensurePrismaConnected();
      const logs = await prisma.agentLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      dbLogs = logs.map(l => ({
        id: l.id,
        type: l.type,
        market: l.market,
        message: l.message,
        details: l.details,
        createdAt: l.createdAt.toISOString(),
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

    return NextResponse.json({
      success: true,
      data: {
        // 기본 에이전트 상태
        isRunning: agentStatus.isRunning,
        currentSessionId: agentStatus.currentSessionId,
        lastCycleTime: agentStatus.lastCycleTime?.toISOString() || null,
        totalCycles: agentStatus.totalCycles,
        totalTrades: agentStatus.totalTrades,
        dailyPnL: agentStatus.dailyPnL,
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
              && effectiveSettings.strategyAggressiveness === 'TEST',
            // ── testModeApplied 상세 진단 ──
            testModeDiagnostics: {
              orderExecutionMode: effectiveSettings.orderExecutionMode,
              strategyAggressiveness: effectiveSettings.strategyAggressiveness,
              signalThreshold: effectiveSettings.signalThreshold,
              weakSignalThreshold: effectiveSettings.weakSignalThreshold,
              minConfidenceThreshold: effectiveSettings.minConfidenceThreshold,
              aggressivenessSource: settingsSources.strategyAggressiveness,
              isTestMode: effectiveSettings.strategyAggressiveness === 'TEST',
              isPaperMode: effectiveSettings.orderExecutionMode === 'PAPER',
              isDemoMode: effectiveSettings.tradingMode === 'DEMO',
              expectedThresholds: effectiveSettings.strategyAggressiveness === 'TEST'
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
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `상태 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
