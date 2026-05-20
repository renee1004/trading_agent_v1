// 자동매매 세션 관리 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  try {
    const session = await db.tradingSession.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return NextResponse.json({ 
        success: true, 
        data: { 
          status: 'STOPPED', 
          message: '자동매매 세션이 없습니다.' 
        } 
      });
    }

    const winRate = session.totalTrades > 0 
      ? ((session.winTrades / session.totalTrades) * 100).toFixed(1) 
      : '0';

    return NextResponse.json({ 
      success: true, 
      data: {
        ...session,
        winRate: parseFloat(winRate),
        duration: session.startedAt 
          ? Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 60000) 
          : 0,
      }
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '상태 조회 실패' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, strategyId } = body; // action: 'START', 'STOP', 'PAUSE'

    if (action === 'START') {
      // 기존 실행 중인 세션 정지
      await db.tradingSession.updateMany({
        where: { status: 'RUNNING' },
        data: { status: 'STOPPED', stoppedAt: new Date() },
      });

      const session = await db.tradingSession.create({
        data: {
          status: 'RUNNING',
          strategyId,
          startedAt: new Date(),
        },
      });

      return NextResponse.json({ 
        success: true, 
        data: session,
        message: '자동매매가 시작되었습니다.' 
      });
    }

    if (action === 'STOP' || action === 'PAUSE') {
      const runningSession = await db.tradingSession.findFirst({
        where: { status: 'RUNNING' },
        orderBy: { createdAt: 'desc' },
      });

      if (runningSession) {
        await db.tradingSession.update({
          where: { id: runningSession.id },
          data: { 
            status: action === 'STOP' ? 'STOPPED' : 'PAUSED',
            stoppedAt: new Date() 
          },
        });
      }

      return NextResponse.json({ 
        success: true, 
        message: action === 'STOP' ? '자동매매가 중지되었습니다.' : '자동매매가 일시정지되었습니다.' 
      });
    }

    return NextResponse.json(
      { success: false, error: '잘못된 액션' },
      { status: 400 }
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '세션 관리 실패' },
      { status: 500 }
    );
  }
}
