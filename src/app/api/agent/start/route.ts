// 에이전트 시작 라우트

import { NextResponse } from 'next/server';
import { startAgent } from '@/lib/trading-agent';

export async function POST() {
  try {
    const result = await startAgent();
    
    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        sessionId: result.sessionId,
        message: result.message,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `시작 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
