// 에이전트 시작 라우트
// 서버 스케줄러 모드로 시작 (브라우저 없이 24/7 실행)

import { NextRequest, NextResponse } from 'next/server';
import { startScheduler } from '@/lib/agent-scheduler';
import { startAgent } from '@/lib/trading-agent';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode || 'SERVER'; // SERVER 또는 BROWSER

    if (mode === 'SERVER') {
      // 서버 스케줄러 모드 - 브라우저 없이 서버에서 24/7 자동 실행
      const result = await startScheduler();
      if (!result.success) {
        return NextResponse.json(
          { success: false, error: result.message },
          { status: 400 }
        );
      }
      return NextResponse.json({
        success: true,
        data: {
          mode: 'SERVER',
          message: result.message,
          description: '서버 스케줄러 모드: 브라우저를 닫아도 서버에서 자동매매가 계속 실행됩니다.',
        },
      });
    } else {
      // 브라우저 모드 - 기존 방식 (브라우저에서 주기적으로 사이클 호출)
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
          mode: 'BROWSER',
          sessionId: result.sessionId,
          message: result.message,
          description: '브라우저 모드: 브라우저가 열려있어야 자동매매가 실행됩니다.',
        },
      });
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `시작 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
