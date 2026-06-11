// 거래 내역 조회 라우트
// 통화별(KRW/USD) 통계 분리 — 혼합 합산 방지
// DB 오류를 명확히 반환 (success:false 대신 warning/error 노출)

import { NextRequest, NextResponse } from 'next/server';
import { db, isDbAvailable, getDbType } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const type = searchParams.get('type'); // BUY, SELL
    const marketFilter = searchParams.get('market'); // DOMESTIC, OVERSEAS
    const statusFilter = searchParams.get('status'); // BLOCKED, FAILED, PENDING, FILLED, CANCELLED

    const where: any = {};
    if (type) where.tradeType = type;
    if (marketFilter) where.market = marketFilter;
    if (statusFilter) where.status = statusFilter;

    // DB 상태 진단 정보
    const dbDiagnostics = {
      dbType: getDbType(),
      dbAvailable: isDbAvailable(),
    };

    let trades;
    let dbError: string | null = null;
    try {
      trades = await db.tradeHistory.findMany({
        where,
        orderBy: { tradedAt: 'desc' },
        take: limit,
      });
    } catch (dbErr) {
      const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      console.error('[TradeHistory] DB query failed:', errMsg);
      dbError = errMsg;
      // DB 조회 실패 시 명확하게 오류 반환
      return NextResponse.json({
        success: false,
        error: '거래내역 DB 조회 실패',
        code: 'DB_QUERY_FAILED',
        diagnostics: dbDiagnostics,
        dbError: errMsg,
        data: {
          trades: [],
          stats: { totalTrades: 0, buyTrades: 0, sellTrades: 0, krw: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 }, usd: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 } },
        },
        total: 0,
      }, { status: 500 });
    }

    // 상태별 카운트 (BLOCKED/FAILED 추적용)
    const statusCounts: Record<string, number> = {};
    for (const t of trades) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
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
          statusCounts,
        },
      },
      total: totalTrades,
      diagnostics: dbDiagnostics,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TradeHistory] Unexpected error:', errMsg);
    return NextResponse.json(
      {
        success: false,
        error: `거래내역 조회 실패: ${errMsg}`,
        code: 'UNEXPECTED_ERROR',
        data: {
          trades: [],
          stats: { totalTrades: 0, buyTrades: 0, sellTrades: 0, krw: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 }, usd: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 } },
        },
        total: 0,
      },
      { status: 500 }
    );
  }
}
