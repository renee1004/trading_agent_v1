// 에이전트 상태 조회 라우트
// 서버 스케줄러 상태 + 에이전트 상태 통합

import { NextResponse } from 'next/server';
import { getAgentStatus, getAgentLogs } from '@/lib/trading-agent';
import { getSchedulerStatus } from '@/lib/agent-scheduler';
import { db } from '@/lib/db';

export async function GET() {
  try {
    // 에이전트 상태
    const agentStatus = getAgentStatus();
    const recentLogs = getAgentLogs(30);

    // 서버 스케줄러 상태
    const schedulerStatus = await getSchedulerStatus();

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
        },

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
