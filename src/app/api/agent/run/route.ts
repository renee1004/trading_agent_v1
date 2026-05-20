// 에이전트 사이클 실행 라우트
// POST: 1사이클 실행 (시그널 분석 → 리스크 체크 → 주문 실행 → 포지션 모니터링)

import { NextResponse } from 'next/server';
import { runAgentCycle, getAgentStatus } from '@/lib/trading-agent';

export async function POST() {
  try {
    const status = getAgentStatus();

    // 에이전트가 실행 중이 아니면 사이클 불가
    if (!status.isRunning) {
      return NextResponse.json(
        { success: false, error: '에이전트가 실행 중이 아닙니다. 먼저 시작해주세요.' },
        { status: 400 }
      );
    }

    const result = await runAgentCycle();

    return NextResponse.json({
      success: result.success,
      data: {
        startTime: result.startTime.toISOString(),
        endTime: result.endTime.toISOString(),
        duration: result.endTime.getTime() - result.startTime.getTime(),
        stocksAnalyzed: result.stocksAnalyzed,
        signalsGenerated: result.signalsGenerated,
        ordersPlaced: result.ordersPlaced,
        positionsMonitored: result.positionsMonitored,
        exitsExecuted: result.exitsExecuted,
        recentLogs: result.logs.slice(0, 20),
        errors: result.errors,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `에이전트 실행 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
