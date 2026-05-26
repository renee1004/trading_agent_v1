// 거래 내역 조회 라우트
// 통화별(KRW/USD) 통계 분리 — 혼합 합산 방지
// 거래내역이 없어도 success:true, data:[] 반환

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

    let trades;
    try {
      trades = await db.tradeHistory.findMany({
        where,
        orderBy: { tradedAt: 'desc' },
        take: limit,
      });
    } catch (dbError) {
      console.error('[TradeHistory] DB query failed:', dbError instanceof Error ? dbError.message : String(dbError));
      // DB 조회 실패 시에도 빈 결과 반환 (스키마 미동기화 등)
      return NextResponse.json({
        success: true,
        data: {
          trades: [],
          stats: { totalTrades: 0, buyTrades: 0, sellTrades: 0, krw: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 }, usd: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 } },
        },
        total: 0,
        warning: 'DB 조회 실패 — 거래내역 테이블을 확인하세요',
        code: 'DB_QUERY_FAILED',
      });
    }

    // 통화별 분리 통계 (KRW와 USD 혼합 합산 방지)
    const krwTrades = trades.filter((t: any) => t.currency === 'KRW');
    const usdTrades = trades.filter((t: any) => t.currency === 'USD');

    const krwStats = {
      totalBuyAmount: krwTrades.filter((t: any) => t.tradeType === 'BUY').reduce((sum: number, t: any) => sum + (t.totalAmount || 0), 0),
      totalSellAmount: krwTrades.filter((t: any) => t.tradeType === 'SELL').reduce((sum: number, t: any) => sum + (t.totalAmount || 0), 0),
      realizedPL: krwTrades.filter((t: any) => t.profitLoss !== null).reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0),
    };

    const usdStats = {
      totalBuyAmount: usdTrades.filter((t: any) => t.tradeType === 'BUY').reduce((sum: number, t: any) => sum + (t.totalAmount || 0), 0),
      totalSellAmount: usdTrades.filter((t: any) => t.tradeType === 'SELL').reduce((sum: number, t: any) => sum + (t.totalAmount || 0), 0),
      realizedPL: usdTrades.filter((t: any) => t.profitLoss !== null).reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0),
    };

    // 전체 통계 (건수는 통화 무관)
    const totalTrades = trades.length;
    const buyTrades = trades.filter((t: any) => t.tradeType === 'BUY').length;
    const sellTrades = trades.filter((t: any) => t.tradeType === 'SELL').length;

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
      },
      total: totalTrades,
    });
  } catch (error) {
    console.error('[TradeHistory] Unexpected error:', error);
    return NextResponse.json(
      { success: true, data: { trades: [], stats: { totalTrades: 0, buyTrades: 0, sellTrades: 0, krw: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 }, usd: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 } } }, total: 0, error: '거래내역 조회 실패', code: 'UNEXPECTED_ERROR' },
      { status: 200 }  // Return 200 even on error — client can still use empty data
    );
  }
}
