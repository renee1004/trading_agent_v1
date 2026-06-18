// 거래 내역 조회 라우트
// 통화별(KRW/USD) 통계 분리 — 혼합 합산 방지
// DB 오류를 명확히 반환 (success:false 대신 warning/error 노출)
//
// 표시 우선순위 (UI 혼란 방지):
//   - FILLED: avgFillPrice ?? filledPrice ?? price  → "체결가"
//   - SUBMITTED/PENDING: orderPrice ?? price       → "주문가"
//   - FAILED/BLOCKED/CANCELLED: price는 참고용      → "주문가(미체결)"
//
// 통계(손익/평균단가/총매수금액)는 executed trades(FILLED+SUBMITTED)만 포함.
// FAILED/BLOCKED는 건수에는 포함, 금액 합산에서는 제외.

import { NextRequest, NextResponse } from 'next/server';
import { db, isDbAvailable, getDbType } from '@/lib/db';

/** 체결된 것으로 간주할 상태 — 통계에 포함 */
const EXECUTED_STATUSES = new Set(['FILLED', 'SUBMITTED']);
/** 미체결 상태 — UI에서 "체결 없음" 표시 */
const NON_EXECUTED_STATUSES = new Set(['FAILED', 'BLOCKED', 'CANCELLED']);

/**
 * status별 표시 가격 계산
 * - FILLED: avgFillPrice ?? filledPrice ?? price
 * - SUBMITTED/PENDING: orderPrice ?? price
 * - FAILED/BLOCKED/CANCELLED: price (참고용 주문가)
 */
function computeDisplayPrice(t: any): {
  displayPrice: number;
  displayPriceType: 'avgFillPrice' | 'filledPrice' | 'orderPrice' | 'signalPrice';
  displayLabel: string;
  isExecuted: boolean;
  isNonExecuted: boolean;
} {
  const status = (t.status || '').toUpperCase();

  if (status === 'FILLED') {
    if (t.avgFillPrice != null) {
      return { displayPrice: t.avgFillPrice, displayPriceType: 'avgFillPrice', displayLabel: '체결가', isExecuted: true, isNonExecuted: false };
    }
    if (t.filledPrice != null) {
      return { displayPrice: t.filledPrice, displayPriceType: 'filledPrice', displayLabel: '체결가', isExecuted: true, isNonExecuted: false };
    }
    // FILLED인데 filledPrice가 없는 경우 (과거 데이터) — price 사용
    return { displayPrice: t.price, displayPriceType: 'signalPrice', displayLabel: '체결가(추정)', isExecuted: true, isNonExecuted: false };
  }

  if (status === 'SUBMITTED' || status === 'PENDING') {
    if (t.orderPrice != null) {
      return { displayPrice: t.orderPrice, displayPriceType: 'orderPrice', displayLabel: '주문가', isExecuted: true, isNonExecuted: false };
    }
    return { displayPrice: t.price, displayPriceType: 'signalPrice', displayLabel: '주문가(추정)', isExecuted: true, isNonExecuted: false };
  }

  // FAILED / BLOCKED / CANCELLED / 기타
  // price는 signalPrice (신호 발생 시 가격) — 참고용으로만 표시
  if (t.orderPrice != null) {
    return { displayPrice: t.orderPrice, displayPriceType: 'orderPrice', displayLabel: '주문가(미체결)', isExecuted: false, isNonExecuted: true };
  }
  return { displayPrice: t.price, displayPriceType: 'signalPrice', displayLabel: '신호가(미체결)', isExecuted: false, isNonExecuted: true };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const type = searchParams.get('type'); // BUY, SELL
    const marketFilter = searchParams.get('market'); // DOMESTIC, OVERSEAS
    const statusFilter = searchParams.get('status'); // BLOCKED, FAILED, PENDING, FILLED, CANCELLED
    // executedOnly=true: FILLED/SUBMITTED만 반환 (기본 false)
    const executedOnly = searchParams.get('executedOnly') === 'true';
    // excludeFailed=true: FAILED/BLOCKED/CANCELLED 제외 (기본 false)
    const excludeFailed = searchParams.get('excludeFailed') === 'true';

    const where: any = {};
    if (type) where.tradeType = type;
    if (marketFilter) where.market = marketFilter;
    if (statusFilter) where.status = statusFilter;
    if (executedOnly) {
      where.status = { in: ['FILLED', 'SUBMITTED'] };
    } else if (excludeFailed) {
      where.status = { notIn: ['FAILED', 'BLOCKED', 'CANCELLED'] };
    }

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
        // 스키마 mismatch(TradeHistory.source 등 v2 컬럼 누락) 시에도
        // API가 500으로 죽지 않도록 명시적 select 사용.
        select: {
          id: true,
          stockCode: true,
          stockName: true,
          tradeType: true,
          quantity: true,
          price: true,
          totalAmount: true,
          strategy: true,
          profitLoss: true,
          profitRate: true,
          status: true,
          orderNo: true,
          signalReason: true,
          market: true,
          exchangeCode: true,
          currency: true,
          source: true,
          orderExecutionMode: true,
          currentPrice: true,
          orderPrice: true,
          filledPrice: true,
          avgFillPrice: true,
          slippagePercent: true,
          rtCd: true,
          msgCd: true,
          msg1: true,
          tradedAt: true,
          createdAt: true,
        },
      });
    } catch (dbErr) {
      const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      console.error('[TradeHistory] DB query failed:', errMsg);

      // 스키마 mismatch 시 안전한 v1 컬럼으로 재시도
      const isSchemaMismatch = errMsg.includes('does not exist') || errMsg.includes('column');
      if (isSchemaMismatch) {
        console.warn('[TradeHistory] 스키마 mismatch — v1 컬럼만 select하여 재시도');
        try {
          trades = await db.tradeHistory.findMany({
            where,
            orderBy: { tradedAt: 'desc' },
            take: limit,
            select: {
              id: true,
              stockCode: true,
              stockName: true,
              tradeType: true,
              quantity: true,
              price: true,
              totalAmount: true,
              strategy: true,
              profitLoss: true,
              profitRate: true,
              status: true,
              orderNo: true,
              signalReason: true,
              market: true,
              exchangeCode: true,
              currency: true,
              tradedAt: true,
              createdAt: true,
            },
          });
          // v2 컬럼이 없는 것으로 간주 — 객체에 기본값 채우기
          trades = trades.map((t: any) => ({
            ...t,
            source: 'AGENT',
            orderExecutionMode: 'DRY_RUN',
            currentPrice: null,
            orderPrice: null,
            filledPrice: null,
            avgFillPrice: null,
            slippagePercent: null,
            rtCd: null,
            msgCd: null,
            msg1: null,
          }));
          dbError = null; // 재시도 성공
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error('[TradeHistory] v1 재시도도 실패:', retryMsg);
          return NextResponse.json({
            success: false,
            error: '거래내역 DB 조회 실패',
            code: 'SCHEMA_MISMATCH',
            diagnostics: dbDiagnostics,
            dbError: retryMsg,
            hint: 'Railway DB에 TradeHistory v2 컬럼(source, orderExecutionMode 등)이 없습니다. '
              + 'Railway 서버 재배포 또는 "npx prisma migrate deploy" 실행 필요. '
              + '마이그레이션 파일: prisma/migrations/20250618010000_tradehistory_v2_fields/',
            data: {
              trades: [],
              stats: { totalTrades: 0, buyTrades: 0, sellTrades: 0, krw: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 }, usd: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 } },
            },
            total: 0,
          }, { status: 500 });
        }
      } else {
        return NextResponse.json({
          success: false,
          error: '거래내역 DB 조회 실패',
          code: 'DB_QUERY_FAILED',
          diagnostics: dbDiagnostics,
          dbError: errMsg,
          hint: 'DB 연결 또는 쿼리 오류',
          data: {
            trades: [],
            stats: { totalTrades: 0, buyTrades: 0, sellTrades: 0, krw: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 }, usd: { totalBuyAmount: 0, totalSellAmount: 0, realizedPL: 0 } },
          },
          total: 0,
        }, { status: 500 });
      }
    }

    // ── 각 거래에 displayPrice/displayPriceType/displayLabel/isExecuted 추가 ──
    const tradesWithDisplay = trades.map((t: any) => {
      const display = computeDisplayPrice(t);
      return {
        ...t,
        // signalPrice = Prisma schema의 price 필드 (신호 발생 시 가격)
        signalPrice: t.price,
        displayPrice: display.displayPrice,
        displayPriceType: display.displayPriceType,
        displayLabel: display.displayLabel,
        isExecuted: display.isExecuted,
        isNonExecuted: display.isNonExecuted,
      };
    });

    // 상태별 카운트 (BLOCKED/FAILED 추적용)
    const statusCounts: Record<string, number> = {};
    for (const t of tradesWithDisplay) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }

    // ── 통계: 체결된 거래(FILLED + SUBMITTED)만 포함 ──
    // FAILED/BLOCKED/CANCELLED는 건수에는 포함하되 금액 합산에서 제외
    const executedTrades = tradesWithDisplay.filter((t: any) => EXECUTED_STATUSES.has((t.status || '').toUpperCase()));
    const nonExecutedTrades = tradesWithDisplay.filter((t: any) => NON_EXECUTED_STATUSES.has((t.status || '').toUpperCase()));

    // 통화별 분리 통계 (executedTrades만)
    const krwExecuted = executedTrades.filter((t: any) => t.currency === 'KRW');
    const usdExecuted = executedTrades.filter((t: any) => t.currency === 'USD');

    const krwStats = {
      totalBuyAmount: krwExecuted.filter((t: any) => t.tradeType === 'BUY').reduce((sum: number, t: any) => sum + (t.displayPrice * t.quantity || 0), 0),
      totalSellAmount: krwExecuted.filter((t: any) => t.tradeType === 'SELL').reduce((sum: number, t: any) => sum + (t.displayPrice * t.quantity || 0), 0),
      realizedPL: krwExecuted.filter((t: any) => t.profitLoss !== null).reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0),
      buyCount: krwExecuted.filter((t: any) => t.tradeType === 'BUY').length,
      sellCount: krwExecuted.filter((t: any) => t.tradeType === 'SELL').length,
    };

    const usdStats = {
      totalBuyAmount: usdExecuted.filter((t: any) => t.tradeType === 'BUY').reduce((sum: number, t: any) => sum + (t.displayPrice * t.quantity || 0), 0),
      totalSellAmount: usdExecuted.filter((t: any) => t.tradeType === 'SELL').reduce((sum: number, t: any) => sum + (t.displayPrice * t.quantity || 0), 0),
      realizedPL: usdExecuted.filter((t: any) => t.profitLoss !== null).reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0),
      buyCount: usdExecuted.filter((t: any) => t.tradeType === 'BUY').length,
      sellCount: usdExecuted.filter((t: any) => t.tradeType === 'SELL').length,
    };

    // 전체 통계 (건수는 통화 무관, executed/nonExecuted 분리)
    const totalTrades = tradesWithDisplay.length;
    const executedCount = executedTrades.length;
    const nonExecutedCount = nonExecutedTrades.length;
    const buyTrades = tradesWithDisplay.filter((t: any) => t.tradeType === 'BUY').length;
    const sellTrades = tradesWithDisplay.filter((t: any) => t.tradeType === 'SELL').length;

    return NextResponse.json({
      success: true,
      data: {
        trades: tradesWithDisplay,
        stats: {
          totalTrades,
          executedCount,
          nonExecutedCount,
          buyTrades,
          sellTrades,
          krw: krwStats,
          usd: usdStats,
          statusCounts,
        },
      },
      total: totalTrades,
      diagnostics: dbDiagnostics,
      // 사용자가 혼동하지 않도록 명시적 필드 안내
      fieldLegend: {
        signalPrice: '신호 발생 시 가격 (참고용)',
        orderPrice: '주문 입력 가격',
        filledPrice: '1차 체결 가격',
        avgFillPrice: '평균 체결 가격 (완전 체결 시)',
        displayPrice: 'UI 표시용 우선순위 적용 가격 (FILLED→avgFillPrice, SUBMITTED→orderPrice, FAILED→참고용)',
        displayPriceType: 'displayPrice가 어떤 필드에서 왔는지',
        displayLabel: 'UI 라벨 (체결가/주문가/주문가(미체결))',
        isExecuted: '체결된 거래 여부 (FILLED/SUBMITTED) — 통계에 포함',
        isNonExecuted: '미체결 여부 (FAILED/BLOCKED/CANCELLED) — 통계에서 제외',
      },
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
