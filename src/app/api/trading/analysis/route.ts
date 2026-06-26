// GET /api/trading/analysis
// 거래별 상세 분석 API
// BUY-SELL 쌍을 매칭하여 진입/청산 정보, 수익, 비용, 청산 사유 등을 종합 분석
// 필드:
//   tradeId, stockCode, stockName, buyTime, sellTime, holdingMinutes,
//   entryPrice, exitPrice, quantity, grossPnL, fee, tax, netPnL, profitRate,
//   entryReason, exitReason, strategy, buyScore, sellScore,
//   marketCondition, wasTrailingStop, wasStopLoss, wasTakeProfit

import { NextRequest, NextResponse } from 'next/server';
import { db, isDbAvailable, getDbType } from '@/lib/db';

// ────────────────────────────────────────────────────────────────
// 수수료/세금 계산
// ────────────────────────────────────────────────────────────────
// 한국투자증권 기준 (대략적)
//   국내 주식:
//     매수 수수료 = 0.015% (온라인 증권사 평균)
//     매도 수수료 = 0.015%
//     매도 세금  = 0.23% (증권거래세, 코스닥 0.23%, 코스피 0.15% → 여기서는 0.23% 통일)
//   해외 주식 (미국):
//     매수/매도 수수료 = 건당 약 $1 (또는 거래금액의 0.0025% — 더 큰 값 적용)
//     매도 세금 = 없음 (한국 거주자 미국 주식 양도소득세는 별도 신고)
function calculateFeesAndTax(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  market: string,
  currency: string,
): { fee: number; tax: number } {
  if (market === 'OVERSEAS' || currency === 'USD') {
    // 해외: 건당 최소 $1 수수료 (양쪽), 세금 없음
    const notionalBuy = entryPrice * quantity;
    const notionalSell = exitPrice * quantity;
    const feeRate = 0.000025; // 0.0025%
    const fee = Math.max(1, notionalBuy * feeRate) + Math.max(1, notionalSell * feeRate);
    return { fee: parseFloat(fee.toFixed(2)), tax: 0 };
  }
  // 국내: 매수 0.015% + 매도 0.015% + 매도 세금 0.23%
  const notionalBuy = entryPrice * quantity;
  const notionalSell = exitPrice * quantity;
  const fee = notionalBuy * 0.00015 + notionalSell * 0.00015;
  const tax = notionalSell * 0.0023;
  return {
    fee: parseFloat(fee.toFixed(0)),
    tax: parseFloat(tax.toFixed(0)),
  };
}

// ────────────────────────────────────────────────────────────────
// signalReason / msg1 텍스트에서 청산 사유 추출
// ────────────────────────────────────────────────────────────────
function detectExitFlags(
  entryReason: string | null,
  exitReason: string | null,
  msg1: string | null,
): {
  wasTrailingStop: boolean;
  wasStopLoss: boolean;
  wasTakeProfit: boolean;
  exitReasonNormalized: string;
} {
  const fullText = `${entryReason || ''} ${exitReason || ''} ${msg1 || ''}`.toLowerCase();
  const wasStopLoss =
    fullText.includes('손절') ||
    fullText.includes('stop loss') ||
    fullText.includes('stoploss') ||
    fullText.includes('stop-loss') ||
    fullText.includes('스탑로스') ||
    fullText.includes('리스크') && fullText.includes('청산');
  const wasTakeProfit =
    fullText.includes('익절') ||
    fullText.includes('take profit') ||
    fullText.includes('takeprofit') ||
    fullText.includes('목표가') ||
    fullText.includes('수익 실현');
  const wasTrailingStop =
    fullText.includes('트레일링') ||
    fullText.includes('trailing') ||
    fullText.includes('추적 손절') ||
    fullText.includes('trailing stop');
  // 정규화된 사유 텍스트
  let exitReasonNormalized = exitReason || '';
  if (!exitReasonNormalized && msg1) exitReasonNormalized = msg1;
  if (wasTrailingStop) exitReasonNormalized = 'TRAILING_STOP';
  else if (wasStopLoss) exitReasonNormalized = 'STOP_LOSS';
  else if (wasTakeProfit) exitReasonNormalized = 'TAKE_PROFIT';
  else if (exitReasonNormalized) exitReasonNormalized = 'SIGNAL';
  else exitReasonNormalized = 'UNKNOWN';
  return { wasTrailingStop, wasStopLoss, wasTakeProfit, exitReasonNormalized };
}

// ────────────────────────────────────────────────────────────────
// signalReason에서 점수 추출 (예: "신뢰도 75", "score 75", "75점")
// ────────────────────────────────────────────────────────────────
function extractScore(reason: string | null): number | null {
  if (!reason) return null;
  const patterns = [
    /신뢰도\s*:?\s*(\d+(?:\.\d+)?)/i,
    /score\s*:?\s*(\d+(?:\.\d+)?)/i,
    /점수\s*:?\s*(\d+(?:\.\d+)?)/i,
    /신호\s*점수\s*:?\s*(\d+(?:\.\d+)?)/i,
    /\((\d+(?:\.\d+)?)\s*점\)/,
    /\[(\d+(?:\.\d+)?)\]/,
  ];
  for (const pattern of patterns) {
    const m = reason.match(pattern);
    if (m && m[1]) {
      const score = parseFloat(m[1]);
      if (!Number.isNaN(score) && score >= 0 && score <= 100) return score;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// marketCondition 추정: signalReason에서 힌트 추출
// ────────────────────────────────────────────────────────────────
function detectMarketCondition(reason: string | null): string {
  if (!reason) return 'UNKNOWN';
  const lower = reason.toLowerCase();
  if (lower.includes('추세') || lower.includes('trend') || lower.includes('상승 전환') || lower.includes('하락 전환')) {
    return 'TREND';
  }
  if (lower.includes('횡보') || lower.includes('range') || lower.includes('박스권')) {
    return 'RANGE';
  }
  if (lower.includes('변동성') || lower.includes('volatil')) {
    return 'VOLATILE';
  }
  if (lower.includes('평균 회귀') || lower.includes('mean reversion') || lower.includes('과매수') || lower.includes('과매도')) {
    return 'MEAN_REVERSION';
  }
  return 'UNKNOWN';
}

// ────────────────────────────────────────────────────────────────
// GET 핸들러
// ────────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '100');
    const strategy = searchParams.get('strategy'); // 전략 필터
    const stockCode = searchParams.get('stockCode'); // 종목 필터
    const onlyClosed = searchParams.get('onlyClosed') !== '0'; // 기본: 청산된 거래만

    const where: any = {
      status: { notIn: ['CANCELLED', 'FAILED', 'BLOCKED', 'PENDING'] },
    };
    // 기본: 오늘 KST 이후만 (?includeHistorical=true → 전체)
    const includeHistorical = searchParams.get('includeHistorical') === 'true';
    if (!includeHistorical) {
      const now = new Date();
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstNow = new Date(now.getTime() + kstOffset);
      const kstDateStr = kstNow.toISOString().slice(0, 10);
      where.tradedAt = { gte: new Date(`${kstDateStr}T00:00:00+09:00`) };
    }
    if (strategy) where.strategy = strategy;
    if (stockCode) where.stockCode = stockCode;

    const allTrades = await db.tradeHistory.findMany({
      where,
      orderBy: { tradedAt: 'asc' },
      take: limit * 2, // BUY+SELL 쌍이므로 여유 있게
    });

    // ── 1. BUY-SELL 쌍 매칭 (종목 + 전략 기준 FIFO) ──
    const buyMap = new Map<string, any[]>();
    const analysisRows: any[] = [];

    for (const trade of allTrades) {
      const key = `${trade.stockCode}-${trade.strategy || 'UNKNOWN'}`;
      if (trade.tradeType === 'BUY') {
        if (!buyMap.has(key)) buyMap.set(key, []);
        buyMap.get(key)!.push(trade);
      } else if (trade.tradeType === 'SELL') {
        const buys = buyMap.get(key);
        if (buys && buys.length > 0) {
          const matchingBuy = buys.shift(); // FIFO
          if (matchingBuy) {
            const entryPrice = matchingBuy.avgFillPrice || matchingBuy.filledPrice || matchingBuy.price;
            const exitPrice = trade.avgFillPrice || trade.filledPrice || trade.price;
            const qty = Math.min(matchingBuy.quantity, trade.quantity);
            const grossPnL = (exitPrice - entryPrice) * qty;
            const { fee, tax } = calculateFeesAndTax(
              entryPrice, exitPrice, qty, trade.market, trade.currency,
            );
            const netPnL = grossPnL - fee - tax;
            const profitRate = entryPrice > 0 ? (netPnL / (entryPrice * qty)) * 100 : 0;
            const buyTime = new Date(matchingBuy.tradedAt);
            const sellTime = new Date(trade.tradedAt);
            const holdingMinutes = Math.max(0, Math.round((sellTime.getTime() - buyTime.getTime()) / 60000));
            const { wasTrailingStop, wasStopLoss, wasTakeProfit, exitReasonNormalized } = detectExitFlags(
              matchingBuy.signalReason, trade.signalReason, trade.msg1,
            );
            const buyScore = extractScore(matchingBuy.signalReason);
            const sellScore = extractScore(trade.signalReason);
            const marketCondition = detectMarketCondition(matchingBuy.signalReason);

            analysisRows.push({
              tradeId: trade.id,
              buyTradeId: matchingBuy.id,
              sellTradeId: trade.id,
              stockCode: trade.stockCode,
              stockName: trade.stockName,
              market: trade.market,
              currency: trade.currency,
              strategy: trade.strategy || matchingBuy.strategy || 'UNKNOWN',
              buyTime: buyTime.toISOString(),
              sellTime: sellTime.toISOString(),
              holdingMinutes,
              entryPrice,
              exitPrice,
              quantity: qty,
              grossPnL: parseFloat(grossPnL.toFixed(2)),
              fee,
              tax,
              netPnL: parseFloat(netPnL.toFixed(2)),
              profitRate: parseFloat(profitRate.toFixed(2)),
              entryReason: matchingBuy.signalReason || '',
              exitReason: trade.signalReason || trade.msg1 || '',
              exitReasonType: exitReasonNormalized,
              buyScore,
              sellScore,
              marketCondition,
              wasTrailingStop,
              wasStopLoss,
              wasTakeProfit,
              orderExecutionMode: trade.orderExecutionMode,
            });
          }
        }
      }
    }

    // 최신 순 정렬
    analysisRows.sort((a, b) => new Date(b.sellTime).getTime() - new Date(a.sellTime).getTime());
    const sliced = analysisRows.slice(0, limit);

    // ── 2. 요약 통계 (청산된 거래 기준) ──
    const winTrades = sliced.filter(t => t.netPnL > 0);
    const lossTrades = sliced.filter(t => t.netPnL < 0);
    const totalNetPnL = sliced.reduce((sum, t) => sum + t.netPnL, 0);
    const totalFee = sliced.reduce((sum, t) => sum + t.fee, 0);
    const totalTax = sliced.reduce((sum, t) => sum + t.tax, 0);
    const avgWin = winTrades.length > 0
      ? winTrades.reduce((s, t) => s + t.netPnL, 0) / winTrades.length : 0;
    const avgLoss = lossTrades.length > 0
      ? Math.abs(lossTrades.reduce((s, t) => s + t.netPnL, 0) / lossTrades.length) : 0;
    const winRate = sliced.length > 0 ? (winTrades.length / sliced.length) * 100 : 0;
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
    const expectedValue = (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss;

    // ── 3. 청산 사유별 손익 ──
    const exitReasonPnL = new Map<string, {
      exitReasonType: string;
      count: number;
      totalNetPnL: number;
      avgNetPnL: number;
      winCount: number;
    }>();
    for (const row of sliced) {
      const key = row.exitReasonType;
      const existing = exitReasonPnL.get(key);
      if (existing) {
        existing.count++;
        existing.totalNetPnL += row.netPnL;
        if (row.netPnL > 0) existing.winCount++;
      } else {
        exitReasonPnL.set(key, {
          exitReasonType: key,
          count: 1,
          totalNetPnL: row.netPnL,
          avgNetPnL: row.netPnL,
          winCount: row.netPnL > 0 ? 1 : 0,
        });
      }
    }
    for (const [, val] of exitReasonPnL) {
      val.avgNetPnL = parseFloat((val.totalNetPnL / val.count).toFixed(2));
      val.totalNetPnL = parseFloat(val.totalNetPnL.toFixed(2));
    }

    return NextResponse.json({
      success: true,
      data: {
        trades: sliced,
        summary: {
          totalAnalyzedTrades: sliced.length,
          winCount: winTrades.length,
          lossCount: lossTrades.length,
          winRate: parseFloat(winRate.toFixed(2)),
          totalNetPnL: parseFloat(totalNetPnL.toFixed(2)),
          totalFee: parseFloat(totalFee.toFixed(2)),
          totalTax: parseFloat(totalTax.toFixed(2)),
          avgWin: parseFloat(avgWin.toFixed(2)),
          avgLoss: parseFloat(avgLoss.toFixed(2)),
          profitFactor: profitFactor === Infinity ? 'Infinity' : parseFloat(profitFactor.toFixed(2)),
          expectedValue: parseFloat(expectedValue.toFixed(2)),
        },
        exitReasonBreakdown: Array.from(exitReasonPnL.values()),
      },
      diagnostics: {
        dbType: getDbType(),
        dbAvailable: isDbAvailable(),
        filters: { strategy, stockCode, onlyClosed },
      },
    });
  } catch (error) {
    console.error('[TradeAnalysis] 오류:', error);
    return NextResponse.json(
      {
        success: false,
        error: `거래 분석 실패: ${error instanceof Error ? error.message : 'Unknown'}`,
        code: 'ANALYSIS_ERROR',
      },
      { status: 500 }
    );
  }
}
