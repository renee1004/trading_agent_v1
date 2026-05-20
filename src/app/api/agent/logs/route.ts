// 에이전트 로그 조회 라우트

import { NextRequest, NextResponse } from 'next/server';
import { getAgentLogs } from '@/lib/trading-agent';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const type = searchParams.get('type'); // INFO, SIGNAL, TRADE, RISK, ERROR, EXIT

    const allLogs = getAgentLogs(limit);
    
    const filteredLogs = type 
      ? allLogs.filter(log => log.type === type)
      : allLogs;

    return NextResponse.json({
      success: true,
      data: filteredLogs.map(log => ({
        id: log.id,
        timestamp: log.timestamp.toISOString(),
        type: log.type,
        market: log.market,
        message: log.message,
        details: log.details,
      })),
      total: filteredLogs.length,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `로그 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
