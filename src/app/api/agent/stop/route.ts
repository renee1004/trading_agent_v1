// 에이전트 중지 라우트
// 서버 스케줄러 및 에이전트 모두 중지

import { NextResponse } from 'next/server';
import { stopScheduler } from '@/lib/agent-scheduler';
import { stopAgent, getAgentStatus } from '@/lib/trading-agent';
import { db } from '@/lib/db';

export async function POST() {
  try {
    // 1. 서버 스케줄러 중지 시도
    const schedulerResult = await stopScheduler();

    // 2. 에이전트도 중지 (이미 중지되었을 수 있음)
    const agentResult = await stopAgent();

    // 3. DB 상태 확실히 업데이트
    const config = await db.agentConfig.findFirst();
    if (config) {
      await db.agentConfig.update({
        where: { id: config.id },
        data: {
          isRunning: false,
          currentSessionId: null,
        },
      });
    }

    return NextResponse.json({
      success: true,
      message: schedulerResult.success
        ? schedulerResult.message
        : agentResult.success
          ? agentResult.message
          : '에이전트가 이미 중지되어 있습니다.',
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `중지 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
