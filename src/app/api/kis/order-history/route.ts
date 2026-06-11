// KIS 주문내역 조회 라우트
// KIS 모의계좌의 실제 주문내역과 내부 DB 거래내역을 비교 가능
// 국내주식 체결내역 + 내부 TradeHistory 비교 결과 제공

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const market = searchParams.get('market') || 'DOMESTIC'; // DOMESTIC, OVERSEAS

    // ── 1. 내부 DB 거래내역 조회 ──
    let dbTrades: any[] = [];
    let dbError: string | null = null;
    try {
      dbTrades = await db.tradeHistory.findMany({
        where: { market },
        orderBy: { tradedAt: 'desc' },
        take: 50,
      });
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }

    // ── 2. KIS API 주문내역 조회 ──
    let kisOrders: any[] = [];
    let kisError: string | null = null;
    let kisConnected = false;

    try {
      const kisConfig = await db.kisConfig.findFirst();

      if (kisConfig) {
        kisConnected = true;
        const { KisApiClient } = await import('@/lib/kis-api');
        const kisClient = new KisApiClient({
          appKey: kisConfig.appKey,
          appSecret: kisConfig.appSecret,
          accountNo: kisConfig.accountNo,
          isDemo: kisConfig.isDemo,
        });

        // KIS 토큰 확보
        const token = await kisClient.ensureToken();

        if (market === 'DOMESTIC') {
          // 국내주식 체결내역 조회 (당일)
          const result = await kisClient.getInquireDailyTrades();
          kisOrders = result;
        } else {
          // 해외주식 체결내역 조회 (당일)
          const result = await kisClient.getInquireOverseasDailyTrades();
          kisOrders = result;
        }
      }
    } catch (err) {
      kisError = err instanceof Error ? err.message : String(err);
    }

    // ── 3. 비교 분석 ──
    // KIS 주문번호 기준으로 내부 DB와 매칭
    const dbOrderNos = new Set(dbTrades.map((t: any) => t.orderNo).filter(Boolean));
    const kisOrderNos = new Set(kisOrders.map((o: any) => o.orderNo).filter(Boolean));

    // KIS에만 있는 주문 (내부 DB에 누락)
    const onlyInKis = kisOrders.filter((o: any) => o.orderNo && !dbOrderNos.has(o.orderNo));

    // 내부 DB에만 있는 주문 (KIS에는 없음 - BLOCKED/FAILED 등)
    const onlyInDb = dbTrades.filter((t: any) => t.orderNo && !kisOrderNos.has(t.orderNo));

    // 상태별 통계
    const dbStatusCounts: Record<string, number> = {};
    for (const t of dbTrades) {
      dbStatusCounts[t.status] = (dbStatusCounts[t.status] || 0) + 1;
    }

    return NextResponse.json({
      success: true,
      data: {
        market,
        // 내부 DB 거래내역
        dbTrades: dbTrades.map((t: any) => ({
          id: t.id,
          stockCode: t.stockCode,
          stockName: t.stockName,
          tradeType: t.tradeType,
          quantity: t.quantity,
          price: t.price,
          totalAmount: t.totalAmount,
          status: t.status,
          orderNo: t.orderNo,
          strategy: t.strategy,
          source: t.source,
          orderExecutionMode: t.orderExecutionMode,
          rtCd: t.rtCd,
          msgCd: t.msgCd,
          msg1: t.msg1,
          tradedAt: t.tradedAt?.toISOString?.() || t.tradedAt,
        })),
        dbStatusCounts,
        dbError,
        // KIS 실제 주문내역
        kisOrders,
        kisConnected,
        kisError,
        // 비교 분석
        comparison: {
          onlyInKis: onlyInKis.length,
          onlyInDb: onlyInDb.length,
          matched: Math.max(0, dbTrades.length - onlyInDb.length),
          onlyInKisDetails: onlyInKis.slice(0, 10),
          onlyInDbDetails: onlyInDb.slice(0, 10).map((t: any) => ({
            stockCode: t.stockCode,
            stockName: t.stockName,
            status: t.status,
            orderNo: t.orderNo,
            msg1: t.msg1,
          })),
        },
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: `주문내역 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}`,
      },
      { status: 500 }
    );
  }
}
