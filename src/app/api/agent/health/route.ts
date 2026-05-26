// 헬스체크 API
// 외부 모니터링(UptimeRobot 등)에서 스케줄러 상태를 확인할 수 있는 엔드포인트
// 스케줄러가 중단된 경우 자동 복구 시도

import { NextResponse } from 'next/server';
import { getSchedulerStatus, autoRecoverScheduler } from '@/lib/agent-scheduler';
import { getAgentStatus } from '@/lib/trading-agent';

export async function GET() {
  try {
    const agentStatus = getAgentStatus();
    const schedulerStatus = await getSchedulerStatus();

    // 스케줄러가 실행되어야 하는데 중단된 경우 자동 복구 시도
    if (!schedulerStatus.isSchedulerRunning && agentStatus.isRunning) {
      console.warn('[Health] 스케줄러 중단 감지, 자동 복구 시도...');
      try {
        await autoRecoverScheduler();
        console.log('[Health] 자동 복구 성공');
      } catch (recoveryError) {
        console.error('[Health] 자동 복구 실패:', recoveryError);
      }
    }

    // 헬스 상태 판별
    const isHealthy = schedulerStatus.isSchedulerRunning || !agentStatus.isRunning;
    const httpStatus = isHealthy ? 200 : 503;

    return NextResponse.json(
      {
        status: isHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        scheduler: {
          isRunning: schedulerStatus.isSchedulerRunning,
          isCycleRunning: schedulerStatus.isCycleRunning,
          errorCount: schedulerStatus.errorCount,
          lastCycleAt: schedulerStatus.lastCycleAt?.toISOString() || null,
          currentKST: schedulerStatus.currentKST,
          domesticSession: schedulerStatus.domesticSession,
          isMarketOpen: schedulerStatus.isMarketOpen,
        },
        agent: {
          isRunning: agentStatus.isRunning,
          totalCycles: agentStatus.totalCycles,
          totalTrades: agentStatus.totalTrades,
        },
      },
      { status: httpStatus }
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
