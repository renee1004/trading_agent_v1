import { NextRequest, NextResponse } from 'next/server';
import { stopScheduler } from '@/lib/agent-scheduler';
import { stopAgent } from '@/lib/trading-agent';
import { db } from '@/lib/db';
import { requireAdminApiToken } from '@/lib/api-auth';

export async function POST(request: NextRequest) {
  const authError = requireAdminApiToken(request);
  if (authError) return authError;

  try {
    const schedulerResult = await stopScheduler();
    const agentResult = await stopAgent();

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
