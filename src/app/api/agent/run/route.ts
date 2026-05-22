import { NextRequest, NextResponse } from 'next/server';
import { runAgentCycle, getAgentStatus } from '@/lib/trading-agent';
import { requireAdminApiToken } from '@/lib/api-auth';

export async function POST(request: NextRequest) {
  const authError = requireAdminApiToken(request);
  if (authError) return authError;

  try {
    const status = getAgentStatus();

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
