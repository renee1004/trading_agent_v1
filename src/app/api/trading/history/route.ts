// 거래 내역 조회 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const type = searchParams.get('type'); // BUY, SELL

    const where = type ? { tradeType: type } : {};

    const trades = await db.tradeHistory.findMany({
      where,
      orderBy: { tradedAt: 'desc' },
      take: limit,
    });

    // 통계 계산
    const totalTrades = trades.length;
    const buyTrades = trades.filter(t => t.tradeType === 'BUY').length;
    const sellTrades = trades.filter(t => t.tradeType === 'SELL').length;
    const totalBuyAmount = trades
      .filter(t => t.tradeType === 'BUY')
      .reduce((sum, t) => sum + t.totalAmount, 0);
    const totalSellAmount = trades
      .filter(t => t.tradeType === 'SELL')
      .reduce((sum, t) => sum + t.totalAmount, 0);
    const realizedPL = trades
      .filter(t => t.profitLoss !== null)
      .reduce((sum, t) => sum + (t.profitLoss || 0), 0);

    return NextResponse.json({ 
      success: true, 
      data: {
        trades,
        stats: {
          totalTrades,
          buyTrades,
          sellTrades,
          totalBuyAmount,
          totalSellAmount,
          realizedPL,
        },
      }
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '거래내역 조회 실패' },
      { status: 500 }
    );
  }
}
