// 에이전트 상태 조회 라우트

import { NextResponse } from 'next/server';
import { getAgentStatus, getAgentLogs } from '@/lib/trading-agent';

export async function GET() {
  try {
    const status = getAgentStatus();
    const recentLogs = getAgentLogs(30);

    return NextResponse.json({
      success: true,
      data: {
        isRunning: status.isRunning,
        currentSessionId: status.currentSessionId,
        lastCycleTime: status.lastCycleTime?.toISOString() || null,
        totalCycles: status.totalCycles,
        totalTrades: status.totalTrades,
        dailyPnL: status.dailyPnL,
        lastCycleSummary: status.lastCycleResult ? {
          stocksAnalyzed: status.lastCycleResult.stocksAnalyzed,
          signalsGenerated: status.lastCycleResult.signalsGenerated,
          ordersPlaced: status.lastCycleResult.ordersPlaced,
          positionsMonitored: status.lastCycleResult.positionsMonitored,
          exitsExecuted: status.lastCycleResult.exitsExecuted,
          duration: status.lastCycleResult.endTime.getTime() - status.lastCycleResult.startTime.getTime(),
        } : null,
        recentLogs: recentLogs.map(log => ({
          id: log.id,
          timestamp: log.timestamp.toISOString(),
          type: log.type,
          market: log.market,
          message: log.message,
        })),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `상태 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
