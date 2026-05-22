// 에이전트 상태 조회 라우트
// 서버 스케줄러 상태 + 에이전트 상태 + 배포 버전 정보 통합
// effectiveSettings는 getEffectiveTradingSettings() 공통 함수를 사용하여
// 실제 에이전트 실행 설정과 100% 일치 보장

import { NextResponse } from 'next/server';
import { getAgentStatus, getAgentLogs } from '@/lib/trading-agent';
import { getSchedulerStatus } from '@/lib/agent-scheduler';
import { getEffectiveTradingSettings, formatSettingsSummary } from '@/lib/effective-settings';
import { db } from '@/lib/db';

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

    // 실제 실행 설정 (에이전트와 동일한 getEffectiveTradingSettings 사용)
    const { settings: effectiveSettings, source: settingsSource, sources: settingsSources } = await getEffectiveTradingSettings();

    // DB에서 영속 로그 조회 (최근 30개)
    let dbLogs: Array<{
      id: string;
      type: string;
      market: string;
      message: string;
      details: string | null;
      createdAt: string;
    }> = [];
    try {
      const logs = await db.agentLog.findMany({
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
        },

        // 배포 버전 정보
        version: versionInfo,

        // 실제 실행 설정 (에이전트와 100% 동일한 소스)
        effectiveSettings: {
          enableOverseasAnalysis: effectiveSettings.enableOverseasAnalysis,
          enableOverseasOrder: effectiveSettings.enableOverseasOrder,
          allowAfterHoursTrading: effectiveSettings.allowAfterHoursTrading,
          cycleIntervalMs: effectiveSettings.cycleIntervalMs,
          tradeOnlyMarketHours: effectiveSettings.tradeOnlyMarketHours,
          riskSummary: {
            maxPositionSize: effectiveSettings.maxPositionSize,
            maxDailyLoss: effectiveSettings.maxDailyLoss,
            maxTotalLoss: effectiveSettings.maxTotalLoss,
            maxOpenPositions: effectiveSettings.maxOpenPositions,
            stopLossPercent: effectiveSettings.stopLossPercent,
            takeProfitPercent: effectiveSettings.takeProfitPercent,
            trailingStopPercent: effectiveSettings.trailingStopPercent,
          },
          selectedStrategy: effectiveSettings.selectedStrategy,
        },
        settingsSource,
        settingsSources,

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
