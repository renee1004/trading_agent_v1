// 스케줄러 설정 API
// GET: 현재 설정 조회, POST: 설정 업데이트

import { NextRequest, NextResponse } from 'next/server';
import { getSchedulerStatus, saveSchedulerConfig, loadSchedulerConfig } from '@/lib/agent-scheduler';

export async function GET() {
  try {
    const status = await getSchedulerStatus();
    return NextResponse.json({
      success: true,
      data: {
        config: status.config,
        isSchedulerRunning: status.isSchedulerRunning,
        schedulerMode: status.schedulerMode,
        isMarketOpen: status.isMarketOpen,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `설정 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // 허용된 설정만 업데이트
    const allowedKeys = [
      'cycleIntervalMs',
      'tradeOnlyMarketHours',
      'domesticMarketOpen',
      'domesticMarketClose',
      'overseasMarketOpen',
      'overseasMarketClose',
    ];

    const updates: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (body[key] !== undefined) {
        updates[key] = body[key];
      }
    }

    // 인터벌 검증 (최소 10초, 최대 10분)
    if (updates.cycleIntervalMs !== undefined) {
      const interval = Number(updates.cycleIntervalMs);
      if (interval < 10000) {
        return NextResponse.json(
          { success: false, error: '사이클 주기는 최소 10초 이상이어야 합니다.' },
          { status: 400 }
        );
      }
      if (interval > 600000) {
        return NextResponse.json(
          { success: false, error: '사이클 주기는 최대 10분 이하이어야 합니다.' },
          { status: 400 }
        );
      }
    }

    await saveSchedulerConfig(updates);

    return NextResponse.json({
      success: true,
      message: '스케줄러 설정이 업데이트되었습니다.',
      data: updates,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `설정 업데이트 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
