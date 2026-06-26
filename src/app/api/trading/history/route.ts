// 거래 내역 조회 라우트
// 통화별(KRW/USD) 통계 분리 — 혼합 합산 방지
// DB 오류를 명확히 반환 (success:false 대신 warning/error 노출)
//
// 표시 우선순위 (UI 혼란 방지):
//   orderExecutionMode 기준 분기:
//   - LIVE / FILLED:        avgFillPrice ?? filledPrice ?? price  → "체결가"
//   - PAPER / FILLED:       avgFillPrice ?? filledPrice ?? orderPrice ?? signalPrice → "체결가" (실제 모의투자 체결)
//   - DRY_RUN / FILLED:     signalPrice (또는 simulatedFillPrice)  → "가상체결가"
//   - SUBMITTED/PENDING:    orderPrice ?? price                    → "주문가"
//   - FAILED/BLOCKED:       체결가 없음                            → "실패/차단"
//
// displayStatus (UI 표시용):
//   - DRY_RUN + FILLED → "가상체결"
//   - PAPER/LIVE + FILLED → "체결"
//   - SUBMITTED → "접수"
//   - PENDING → "대기"
//   - FAILED → "실패"
//   - BLOCKED → "차단"
//   - CANCELLED → "취소"
//
// isRealExecution:
//   - LIVE/PAPER인 경우 true (실제 주문/체결 응답이 있는 경우)
//   - DRY_RUN은 false (시뮬레이션)
//
// 통계(손익/평균단가/총매수금액)는 executed trades(FILLED+SUBMITTED)만 포함.
// 단, DRY_RUN 손익은 "가상손익"으로 분리 표시 (realizedPL에 합산하지 않음).
// FAILED/BLOCKED는 건수에는 포함, 금액 합산에서는 제외.

import { NextRequest, NextResponse } from 'next/server';
import { db, isDbAvailable, getDbType } from '@/lib/db';

/** 체결된 것으로 간주할 상태 — 통계에 포함 */
const EXECUTED_STATUSES = new Set(['FILLED', 'SUBMITTED']);
/** 미체결 상태 — UI에서 "체결 없음" 표시 */
const NON_EXECUTED_STATUSES = new Set(['FAILED', 'BLOCKED', 'CANCELLED']);

/**
 * 실제 실행 모드 여부 — DRY_RUN이 아닌 경우 true
 */
function isRealExecutionMode(mode: string | null | undefined): boolean {
  return mode === 'LIVE' || mode === 'PAPER';
}

/**
 * displayStatus 계산 — DRY_RUN + FILLED 조합을 "가상체결"로 변환
 */
function computeDisplayStatus(status: string, mode: string | null | undefined): string {
  const s = (status || '').toUpperCase();
  const m = (mode || 'DRY_RUN').toUpperCase();
  if (s === 'FILLED') {
    return m === 'DRY_RUN' ? '가상체결' : '체결';
  }
  if (s === 'SUBMITTED') return '접수';
  if (s === 'PENDING') return '대기';
  if (s === 'FAILED') return '실패';
  if (s === 'BLOCKED') return '차단';
  if (s === 'CANCELLED') return '취소';
  return s;
}

/**
 * status별 표시 가격 계산 (orderExecutionMode 인식)
 *
 * 표시 우선순위:
 * - LIVE / FILLED:        avgFillPrice ?? filledPrice ?? price  → "체결가"
 * - PAPER / FILLED:       avgFillPrice ?? filledPrice ?? orderPrice ?? signalPrice → "체결가"
 * - DRY_RUN / FILLED:     signalPrice (= price)                 → "가상체결가"
 * - SUBMITTED/PENDING:    orderPrice ?? signalPrice              → "주문가"
 * - FAILED/BLOCKED/CANCELLED: signalPrice (참고용)               → "주문가(미체결)" / "신호가(미체결)"
 */
function computeDisplayPrice(t: any): {
  displayPrice: number;
  displayPriceType: 'avgFillPrice' | 'filledPrice' | 'orderPrice' | 'signalPrice';
  displayLabel: string;
  isExecuted: boolean;
  isNonExecuted: boolean;
  isRealExecution: boolean;
  simulatedFillPrice: number | null;
} {
  const status = (t.status || '').toUpperCase();
  const mode = (t.orderExecutionMode || 'DRY_RUN').toUpperCase();
  const isReal = isRealExecutionMode(mode);

  // simulatedFillPrice: DRY_RUN에서 signalPrice를 가상체결가로 사용
  const simulatedFillPrice = mode === 'DRY_RUN' ? (t.price ?? null) : null;

  // FILLED 처리
  if (status === 'FILLED') {
    // LIVE: avgFillPrice ?? filledPrice ?? price
    if (mode === 'LIVE') {
      if (t.avgFillPrice != null) {
        return { displayPrice: t.avgFillPrice, displayPriceType: 'avgFillPrice', displayLabel: '체결가', isExecuted: true, isNonExecuted: false, isRealExecution: true, simulatedFillPrice: null };
      }
      if (t.filledPrice != null) {
        return { displayPrice: t.filledPrice, displayPriceType: 'filledPrice', displayLabel: '체결가', isExecuted: true, isNonExecuted: false, isRealExecution: true, simulatedFillPrice: null };
      }
      return { displayPrice: t.price, displayPriceType: 'signalPrice', displayLabel: '체결가(추정)', isExecuted: true, isNonExecuted: false, isRealExecution: true, simulatedFillPrice: null };
    }
    // PAPER: avgFillPrice ?? filledPrice ?? orderPrice ?? signalPrice → "체결가"
    if (mode === 'PAPER') {
      if (t.avgFillPrice != null) {
        return { displayPrice: t.avgFillPrice, displayPriceType: 'avgFillPrice', displayLabel: '체결가', isExecuted: true, isNonExecuted: false, isRealExecution: true, simulatedFillPrice: null };
      }
      if (t.filledPrice != null) {
        return { displayPrice: t.filledPrice, displayPriceType: 'filledPrice', displayLabel: '체결가', isExecuted: true, isNonExecuted: false, isRealExecution: true, simulatedFillPrice: null };
      }
      if (t.orderPrice != null) {
        return { displayPrice: t.orderPrice, displayPriceType: 'orderPrice', displayLabel: '체결가(주문가)', isExecuted: true, isNonExecuted: false, isRealExecution: true, simulatedFillPrice: null };
      }
      return { displayPrice: t.price, displayPriceType: 'signalPrice', displayLabel: '체결가(추정)', isExecuted: true, isNonExecuted: false, isRealExecution: true, simulatedFillPrice: null };
    }
    // DRY_RUN: signalPrice (= price) → "가상체결가"
    // 단, avgFillPrice/filledPrice가 있으면 그것을 가상체결가로 사용 (DRY_RUN에서도 가상 체결가를 세팅한 경우)
    if (t.avgFillPrice != null) {
      return { displayPrice: t.avgFillPrice, displayPriceType: 'avgFillPrice', displayLabel: '가상체결가', isExecuted: true, isNonExecuted: false, isRealExecution: false, simulatedFillPrice: t.avgFillPrice };
    }
    if (t.filledPrice != null) {
      return { displayPrice: t.filledPrice, displayPriceType: 'filledPrice', displayLabel: '가상체결가', isExecuted: true, isNonExecuted: false, isRealExecution: false, simulatedFillPrice: t.filledPrice };
    }
    return { displayPrice: t.price, displayPriceType: 'signalPrice', displayLabel: '가상체결가', isExecuted: true, isNonExecuted: false, isRealExecution: false, simulatedFillPrice: t.price ?? null };
  }

  // SUBMITTED / PENDING
  if (status === 'SUBMITTED' || status === 'PENDING') {
    if (t.orderPrice != null) {
      const label = mode === 'DRY_RUN' ? '주문가(시뮬)' : '주문가';
      return { displayPrice: t.orderPrice, displayPriceType: 'orderPrice', displayLabel: label, isExecuted: true, isNonExecuted: false, isRealExecution: isReal, simulatedFillPrice };
    }
    const label = mode === 'DRY_RUN' ? '주문가(시뮬,추정)' : '주문가(추정)';
    return { displayPrice: t.price, displayPriceType: 'signalPrice', displayLabel: label, isExecuted: true, isNonExecuted: false, isRealExecution: isReal, simulatedFillPrice };
  }

  // FAILED / BLOCKED / CANCELLED — 체결가 없음
  if (t.orderPrice != null) {
    return { displayPrice: t.orderPrice, displayPriceType: 'orderPrice', displayLabel: '주문가(미체결)', isExecuted: false, isNonExecuted: true, isRealExecution: isReal, simulatedFillPrice };
  }
  return { displayPrice: t.price, displayPriceType: 'signalPrice', displayLabel: '신호가(미체결)', isExecuted: false, isNonExecuted: true, isRealExecution: isReal, simulatedFillPrice };
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
    // executionMode: LIVE / PAPER / DRY_RUN 필터
    const executionModeFilter = searchParams.get('executionMode'); // DRY_RUN | PAPER | LIVE

    const where: any = {};

    // ── 날짜 필터 (기본: 오늘 KST 자정 이후만) ──
    // ?includeHistorical=true → 과거 데이터도 포함
    const includeHistorical = searchParams.get('includeHistorical') === 'true';
    if (!includeHistorical) {
      // KST 오늘 00:00:00 = UTC 전날 15:00:00
      const now = new Date();
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstNow = new Date(now.getTime() + kstOffset);
      const kstDateStr = kstNow.toISOString().slice(0, 10);
      const startOfTodayKST = new Date(`${kstDateStr}T00:00:00+09:00`);
      where.tradedAt = { gte: startOfTodayKST };
    }

    if (type) where.tradeType = type;
    if (marketFilter) where.market = marketFilter;
    if (statusFilter) where.status = statusFilter;
    if (executionModeFilter) where.orderExecutionMode = executionModeFilter;
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
        displayStatus: computeDisplayStatus(t.status, t.orderExecutionMode),
        isExecuted: display.isExecuted,
        isNonExecuted: display.isNonExecuted,
        isRealExecution: display.isRealExecution,
        simulatedFillPrice: display.simulatedFillPrice,
        priceSource: display.displayPriceType, // UI tooltip용 (displayPrice가 어디서 왔는지)
      };
    });

    // 상태별 카운트 (BLOCKED/FAILED 추적용)
    const statusCounts: Record<string, number> = {};
    for (const t of tradesWithDisplay) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }
    // 실행모드별 카운트 (DRY_RUN/PAPER/LIVE)
    const executionModeCounts: Record<string, number> = {};
    for (const t of tradesWithDisplay) {
      const m = t.orderExecutionMode || 'DRY_RUN';
      executionModeCounts[m] = (executionModeCounts[m] || 0) + 1;
    }

    // ── 통계: 체결된 거래(FILLED + SUBMITTED)만 포함 ──
    // FAILED/BLOCKED/CANCELLED는 건수에는 포함하되 금액 합산에서 제외
    const executedTrades = tradesWithDisplay.filter((t: any) => EXECUTED_STATUSES.has((t.status || '').toUpperCase()));
    const nonExecutedTrades = tradesWithDisplay.filter((t: any) => NON_EXECUTED_STATUSES.has((t.status || '').toUpperCase()));

    // DRY_RUN vs 실제(PAPER/LIVE) 분리
    const realExecutedTrades = executedTrades.filter((t: any) => t.isRealExecution === true);
    const simulatedExecutedTrades = executedTrades.filter((t: any) => t.isRealExecution === false);

    // 통화별 분리 통계 (executedTrades만)
    const krwExecuted = executedTrades.filter((t: any) => t.currency === 'KRW');
    const usdExecuted = executedTrades.filter((t: any) => t.currency === 'USD');
    // 실제 체결만 (PAPER+LIVE)
    const krwRealExecuted = realExecutedTrades.filter((t: any) => t.currency === 'KRW');
    const usdRealExecuted = realExecutedTrades.filter((t: any) => t.currency === 'USD');
    // 가상 체결만 (DRY_RUN)
    const krwSimExecuted = simulatedExecutedTrades.filter((t: any) => t.currency === 'KRW');
    const usdSimExecuted = simulatedExecutedTrades.filter((t: any) => t.currency === 'USD');

    const krwStats = {
      totalBuyAmount: krwExecuted.filter((t: any) => t.tradeType === 'BUY').reduce((sum: number, t: any) => sum + (t.displayPrice * t.quantity || 0), 0),
      totalSellAmount: krwExecuted.filter((t: any) => t.tradeType === 'SELL').reduce((sum: number, t: any) => sum + (t.displayPrice * t.quantity || 0), 0),
      realizedPL: krwRealExecuted.filter((t: any) => t.profitLoss !== null).reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0),
      virtualPL: krwSimExecuted.filter((t: any) => t.profitLoss !== null).reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0),
      buyCount: krwExecuted.filter((t: any) => t.tradeType === 'BUY').length,
      sellCount: krwExecuted.filter((t: any) => t.tradeType === 'SELL').length,
    };

    const usdStats = {
      totalBuyAmount: usdExecuted.filter((t: any) => t.tradeType === 'BUY').reduce((sum: number, t: any) => sum + (t.displayPrice * t.quantity || 0), 0),
      totalSellAmount: usdExecuted.filter((t: any) => t.tradeType === 'SELL').reduce((sum: number, t: any) => sum + (t.displayPrice * t.quantity || 0), 0),
      realizedPL: usdRealExecuted.filter((t: any) => t.profitLoss !== null).reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0),
      virtualPL: usdSimExecuted.filter((t: any) => t.profitLoss !== null).reduce((sum: number, t: any) => sum + (t.profitLoss || 0), 0),
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
          realExecutedCount: realExecutedTrades.length,
          simulatedExecutedCount: simulatedExecutedTrades.length,
          buyTrades,
          sellTrades,
          krw: krwStats,
          usd: usdStats,
          statusCounts,
          executionModeCounts,
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
        simulatedFillPrice: 'DRY_RUN 가상 체결가 (= signalPrice)',
        displayPrice: 'UI 표시용 우선순위 적용 가격',
        displayPriceType: 'displayPrice가 어떤 필드에서 왔는지',
        displayLabel: 'UI 라벨 (체결가/가상체결가/주문가/주문가(미체결))',
        displayStatus: 'UI 표시용 상태 (DRY_RUN+FILLED → 가상체결)',
        isExecuted: '체결된 거래 여부 (FILLED/SUBMITTED) — 통계에 포함',
        isNonExecuted: '미체결 여부 (FAILED/BLOCKED/CANCELLED) — 통계에서 제외',
        isRealExecution: '실제 주문/체결 여부 (PAPER/LIVE=true, DRY_RUN=false)',
        priceSource: 'displayPrice 출처 (= displayPriceType)',
        realizedPL: '실제 체결(PAPER+LIVE) 기준 손익',
        virtualPL: 'DRY_RUN 가상 체결 기준 손익 (시뮬레이션 손익)',
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
