// TradeHistory / AgentLog 전체 리셋 API
//
// POST body: { "confirm": "RESET_TRADE_AND_LOG_HISTORY" }
// 삭제 대상: TradeHistory 전체, AgentLog 전체
// 절대 건드리지 않음: Position, AppSetting, KisConfig, MarketData, 안전설정

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const REQUIRED_CONFIRM = 'RESET_TRADE_AND_LOG_HISTORY';

export async function GET() {
  try {
    const [tradeHistoryCount, agentLogCount] = await Promise.all([
      prisma.tradeHistory.count(),
      prisma.agentLog.count(),
    ]);

    return NextResponse.json({
      success: true,
      tradeHistoryCount,
      agentLogCount,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown';
    console.error('[CleanupTradeHistory] Count failed:', errMsg);
    return NextResponse.json(
      { success: false, error: `조회 실패: ${errMsg}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.confirm !== REQUIRED_CONFIRM) {
      return NextResponse.json(
        {
          success: false,
          error: '잘못된 확인값입니다.',
          required: `{"confirm":"${REQUIRED_CONFIRM}"}`,
        },
        { status: 400 }
      );
    }

    const [tradeHistory, agentLog] = await Promise.all([
      prisma.tradeHistory.deleteMany({}),
      prisma.agentLog.deleteMany({}),
    ]);

    console.log(
      `[CleanupTradeHistory] Reset done: TradeHistory=${tradeHistory.count}, AgentLog=${agentLog.count}`
    );

    return NextResponse.json({
      success: true,
      deleted: {
        tradeHistory: tradeHistory.count,
        agentLog: agentLog.count,
      },
      message: 'TradeHistory and AgentLog have been reset. New records will start from now.',
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown';
    console.error('[CleanupTradeHistory] Reset failed:', errMsg);
    return NextResponse.json(
      { success: false, error: `리셋 실패: ${errMsg}` },
      { status: 500 }
    );
  }
}