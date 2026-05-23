// 거래 내역 조회 라우트
// 통화별(KRW/USD) 통계 분리 — 혼합 합산 방지

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const type = searchParams.get('type'); // BUY, SELL
    const marketFilter = searchParams.get('market'); // DOMESTIC, OVERSEAS

    const where: any = {};
    if (type) where.tradeType = type;
    if (marketFilter) where.market = marketFilter;

    const trades = await db.tradeHistory.findMany({
      where,
      orderBy: { tradedAt: 'desc' },
      take: limit,
    });

    // 통화별 분리 통계 (KRW와 USD 혼합 합산 방지)
    const krwTrades = trades.filter(t => t.currency === 'KRW');
    const usdTrades = trades.filter(t => t.currency === 'USD');

    const krwStats = {
      totalBuyAmount: krwTrades.filter(t => t.tradeType === 'BUY').reduce((sum, t) => sum + t.totalAmount, 0),
      totalSellAmount: krwTrades.filter(t => t.tradeType === 'SELL').reduce((sum, t) => sum + t.totalAmount, 0),
      realizedPL: krwTrades.filter(t => t.profitLoss !== null).reduce((sum, t) => sum + (t.profitLoss || 0), 0),
    };

    const usdStats = {
      totalBuyAmount: usdTrades.filter(t => t.tradeType === 'BUY').reduce((sum, t) => sum + t.totalAmount, 0),
      totalSellAmount: usdTrades.filter(t => t.tradeType === 'SELL').reduce((sum, t) => sum + t.totalAmount, 0),
      realizedPL: usdTrades.filter(t => t.profitLoss !== null).reduce((sum, t) => sum + (t.profitLoss || 0), 0),
    };

    // 전체 통계 (건수는 통화 무관)
    const totalTrades = trades.length;
    const buyTrades = trades.filter(t => t.tradeType === 'BUY').length;
    const sellTrades = trades.filter(t => t.tradeType === 'SELL').length;

    return NextResponse.json({ 
      success: true, 
      data: {
        trades,
        stats: {
          totalTrades,
          buyTrades,
          sellTrades,
          krw: krwStats,
          usd: usdStats,
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
