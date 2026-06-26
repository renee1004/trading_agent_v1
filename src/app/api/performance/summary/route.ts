// GET /api/performance/summary
// 전략 성과 요약 API
// - 총 거래 수, 승률, 평균 수익률/손실률, 손익비, 기대값, 최대 낙폭
// - 종목별 손익, 전략별 손익

import { NextResponse } from 'next/server';
import { db, isDbAvailable, getDbType } from '@/lib/db';

export async function GET() {
  try {
    // InMemory DB도 지원하므로 항상 시도
    // ── 1. 전체 거래 통계 (오늘 KST 이후만) ──
    // BUY+SELL 쌍을 매칭하여 실현 손익을 계산하는 대신,
    // SELL 거래의 profitRate를 기준으로 승/패 판단

    // KST 오늘 00:00:00 이후만
    const now = new Date();
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(now.getTime() + kstOffset);
    const kstDateStr = kstNow.toISOString().slice(0, 10);
    const startOfTodayKST = new Date(`${kstDateStr}T00:00:00+09:00`);

    const allTrades = await db.tradeHistory.findMany({
      where: {
        status: { notIn: ['CANCELLED', 'FAILED'] },
        tradedAt: { gte: startOfTodayKST },
      },
      orderBy: { tradedAt: 'asc' },
    });

    const buyTrades = allTrades.filter(t => t.tradeType === 'BUY');
    const sellTrades = allTrades.filter(t => t.tradeType === 'SELL');
    const totalTrades = allTrades.length;

    // ── 2. 포지션 기반 실현 손익 계산 ──
    // Position 테이블의 realizedPnL 필드 활용 + SELL 거래의 profitRate
    const positions = await db.position.findMany();

    // SELL 거래에서 실현 손익 추출
    const realizedTrades: Array<{
      stockCode: string;
      stockName: string;
      strategy: string;
      profitRate: number;
      profitLoss: number;
      market: string;
    }> = [];

    // BUY-SELL 쌍 매칭 (같은 종목, 같은 전략)
    const buyMap = new Map<string, typeof buyTrades>();
    for (const buy of buyTrades) {
      const key = `${buy.stockCode}-${buy.strategy || 'UNKNOWN'}`;
      if (!buyMap.has(key)) buyMap.set(key, []);
      buyMap.get(key)!.push(buy);
    }

    for (const sell of sellTrades) {
      const key = `${sell.stockCode}-${sell.strategy || 'UNKNOWN'}`;
      const buys = buyMap.get(key);
      if (buys && buys.length > 0) {
        const matchingBuy = buys.shift(); // FIFO
        if (matchingBuy) {
          const buyPrice = matchingBuy.avgFillPrice || matchingBuy.price;
          const sellPrice = sell.avgFillPrice || sell.filledPrice || sell.price;
          const profitRate = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
          const qty = Math.min(matchingBuy.quantity, sell.quantity);
          const profitLoss = (sellPrice - buyPrice) * qty;

          realizedTrades.push({
            stockCode: sell.stockCode,
            stockName: sell.stockName,
            strategy: sell.strategy || matchingBuy.strategy || 'UNKNOWN',
            profitRate,
            profitLoss,
            market: sell.market,
          });
        }
      } else {
        // 매칭되는 BUY 없이 SELL만 있는 경우 (포지션 테이블 기반 추정)
        if (sell.profitRate != null) {
          realizedTrades.push({
            stockCode: sell.stockCode,
            stockName: sell.stockName,
            strategy: sell.strategy || 'UNKNOWN',
            profitRate: sell.profitRate,
            profitLoss: sell.profitLoss || 0,
            market: sell.market,
          });
        }
      }
    }

    // ── 3. 승률/손익비 계산 ──
    const winTrades = realizedTrades.filter(t => t.profitRate > 0);
    const lossTrades = realizedTrades.filter(t => t.profitRate < 0);
    const evenTrades = realizedTrades.filter(t => t.profitRate === 0);

    const winRate = realizedTrades.length > 0
      ? (winTrades.length / realizedTrades.length) * 100
      : 0;

    const avgWinRate = winTrades.length > 0
      ? winTrades.reduce((sum, t) => sum + t.profitRate, 0) / winTrades.length
      : 0;

    const avgLossRate = lossTrades.length > 0
      ? Math.abs(lossTrades.reduce((sum, t) => sum + t.profitRate, 0) / lossTrades.length)
      : 0;

    // 절대금액 기반 평균 수익/손실 (KRW/USD 혼합이므로 통화별 분리)
    const krwRealized = realizedTrades.filter(t => t.market === 'DOMESTIC');
    const usdRealized = realizedTrades.filter(t => t.market === 'OVERSEAS');
    const krwWins = krwRealized.filter(t => t.profitLoss > 0);
    const krwLosses = krwRealized.filter(t => t.profitLoss < 0);
    const usdWins = usdRealized.filter(t => t.profitLoss > 0);
    const usdLosses = usdRealized.filter(t => t.profitLoss < 0);
    const avgWinAmountKRW = krwWins.length > 0
      ? krwWins.reduce((s, t) => s + t.profitLoss, 0) / krwWins.length : 0;
    const avgLossAmountKRW = krwLosses.length > 0
      ? Math.abs(krwLosses.reduce((s, t) => s + t.profitLoss, 0) / krwLosses.length) : 0;
    const avgWinAmountUSD = usdWins.length > 0
      ? usdWins.reduce((s, t) => s + t.profitLoss, 0) / usdWins.length : 0;
    const avgLossAmountUSD = usdLosses.length > 0
      ? Math.abs(usdLosses.reduce((s, t) => s + t.profitLoss, 0) / usdLosses.length) : 0;

    // 손익비 (평균 수익률 / 평균 손실률)
    const profitFactor = avgLossRate > 0 ? avgWinRate / avgLossRate : avgWinRate > 0 ? Infinity : 0;

    // 기대값 = 승률 * 평균 수익률 - (1-승률) * 평균 손실률
    const expectedValue = (winRate / 100) * avgWinRate - ((100 - winRate) / 100) * avgLossRate;

    // ── 4. 최대 낙폭 (MDD) 계산 ──
    // 누적 손익 곡선에서 최대 고점-저점 차이
    let cumulativePnL = 0;
    let peakPnL = 0;
    let maxDrawdown = 0;
    const cumulativePnLHistory: number[] = [];

    for (const trade of realizedTrades) {
      cumulativePnL += trade.profitLoss;
      cumulativePnLHistory.push(cumulativePnL);
      if (cumulativePnL > peakPnL) peakPnL = cumulativePnL;
      const drawdown = peakPnL - cumulativePnL;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // ── 5. 종목별 손익 ──
    const stockPnLMap = new Map<string, {
      stockCode: string;
      stockName: string;
      market: string;
      totalTrades: number;
      winTrades: number;
      lossTrades: number;
      totalProfitLoss: number;
      totalProfitRate: number;
      avgProfitRate: number;
    }>();

    for (const trade of realizedTrades) {
      const key = trade.stockCode;
      const existing = stockPnLMap.get(key);
      if (existing) {
        existing.totalTrades++;
        if (trade.profitRate > 0) existing.winTrades++;
        else if (trade.profitRate < 0) existing.lossTrades++;
        existing.totalProfitLoss += trade.profitLoss;
        existing.totalProfitRate += trade.profitRate;
        existing.avgProfitRate = existing.totalProfitRate / existing.totalTrades;
      } else {
        stockPnLMap.set(key, {
          stockCode: trade.stockCode,
          stockName: trade.stockName,
          market: trade.market,
          totalTrades: 1,
          winTrades: trade.profitRate > 0 ? 1 : 0,
          lossTrades: trade.profitRate < 0 ? 1 : 0,
          totalProfitLoss: trade.profitLoss,
          totalProfitRate: trade.profitRate,
          avgProfitRate: trade.profitRate,
        });
      }
    }

    const stockPerformance = Array.from(stockPnLMap.values())
      .sort((a, b) => b.totalProfitLoss - a.totalProfitLoss);

    // ── 6. 전략별 손익 ──
    const strategyPnLMap = new Map<string, {
      strategy: string;
      totalTrades: number;
      winTrades: number;
      lossTrades: number;
      winRate: number;
      avgProfitRate: number;
      avgLossRate: number;
      profitFactor: number;
      totalProfitLoss: number;
    }>();

    for (const trade of realizedTrades) {
      const key = trade.strategy;
      const existing = strategyPnLMap.get(key);
      if (existing) {
        existing.totalTrades++;
        if (trade.profitRate > 0) existing.winTrades++;
        else if (trade.profitRate < 0) existing.lossTrades++;
        existing.totalProfitLoss += trade.profitLoss;

        // 재계산
        const stratWinRate = existing.winTrades / existing.totalTrades * 100;
        existing.winRate = stratWinRate;
      } else {
        strategyPnLMap.set(key, {
          strategy: trade.strategy,
          totalTrades: 1,
          winTrades: trade.profitRate > 0 ? 1 : 0,
          lossTrades: trade.profitRate < 0 ? 1 : 0,
          winRate: trade.profitRate > 0 ? 100 : 0,
          avgProfitRate: 0,
          avgLossRate: 0,
          profitFactor: 0,
          totalProfitLoss: trade.profitLoss,
        });
      }
    }

    // 전략별 avgProfitRate, avgLossRate, profitFactor 계산
    for (const [, strat] of strategyPnLMap) {
      const stratTrades = realizedTrades.filter(t => t.strategy === strat.strategy);
      const stratWins = stratTrades.filter(t => t.profitRate > 0);
      const stratLosses = stratTrades.filter(t => t.profitRate < 0);
      strat.avgProfitRate = stratWins.length > 0
        ? stratWins.reduce((s, t) => s + t.profitRate, 0) / stratWins.length
        : 0;
      strat.avgLossRate = stratLosses.length > 0
        ? Math.abs(stratLosses.reduce((s, t) => s + t.profitRate, 0) / stratLosses.length)
        : 0;
      strat.profitFactor = strat.avgLossRate > 0 ? strat.avgProfitRate / strat.avgLossRate : strat.avgProfitRate > 0 ? Infinity : 0;
    }

    const strategyPerformance = Array.from(strategyPnLMap.values())
      .sort((a, b) => b.totalProfitLoss - a.totalProfitLoss);

    // ── 7. 청산 사유별 손익 ──
    // signalReason / msg1 텍스트에서 청산 사유 추출
    function detectExitType(reason: string | null, msg1: string | null): string {
      const text = `${reason || ''} ${msg1 || ''}`.toLowerCase();
      if (text.includes('트레일링') || text.includes('trailing')) return 'TRAILING_STOP';
      if (text.includes('손절') || text.includes('stop loss') || text.includes('stoploss')) return 'STOP_LOSS';
      if (text.includes('익절') || text.includes('take profit') || text.includes('목표가') || text.includes('수익 실현')) return 'TAKE_PROFIT';
      if (reason) return 'SIGNAL';
      return 'UNKNOWN';
    }

    const exitReasonPnLMap = new Map<string, {
      exitReasonType: string;
      count: number;
      winCount: number;
      lossCount: number;
      totalProfitLoss: number;
      avgProfitLoss: number;
      avgProfitRate: number;
    }>();

    for (const trade of realizedTrades) {
      // SELL 거래의 signalReason에서 사유 추출 — 매칭된 SELL 거래를 찾아야 함
      // realizedTrades는 SELL 기준이므로, SELL의 원본 trade를 다시 검색
      const sellTrade = sellTrades.find(s =>
        s.stockCode === trade.stockCode &&
        s.strategy === trade.strategy &&
        Math.abs((s.profitRate || 0) - trade.profitRate) < 0.01
      );
      const exitType = detectExitType(sellTrade?.signalReason || null, sellTrade?.msg1 || null);
      const existing = exitReasonPnLMap.get(exitType);
      if (existing) {
        existing.count++;
        if (trade.profitLoss > 0) existing.winCount++;
        else if (trade.profitLoss < 0) existing.lossCount++;
        existing.totalProfitLoss += trade.profitLoss;
        existing.avgProfitLoss = existing.totalProfitLoss / existing.count;
        existing.avgProfitRate = (existing.avgProfitRate * (existing.count - 1) + trade.profitRate) / existing.count;
      } else {
        exitReasonPnLMap.set(exitType, {
          exitReasonType: exitType,
          count: 1,
          winCount: trade.profitLoss > 0 ? 1 : 0,
          lossCount: trade.profitLoss < 0 ? 1 : 0,
          totalProfitLoss: trade.profitLoss,
          avgProfitLoss: trade.profitLoss,
          avgProfitRate: trade.profitRate,
        });
      }
    }
    const exitReasonPerformance = Array.from(exitReasonPnLMap.values())
      .map(e => ({
        ...e,
        totalProfitLoss: parseFloat(e.totalProfitLoss.toFixed(2)),
        avgProfitLoss: parseFloat(e.avgProfitLoss.toFixed(2)),
        avgProfitRate: parseFloat(e.avgProfitRate.toFixed(2)),
      }))
      .sort((a, b) => b.totalProfitLoss - a.totalProfitLoss);

    // ── 8. 현재 미청산 포지션 ──
    const openPositions = positions.map(p => ({
      stockCode: p.stockCode,
      stockName: p.stockName,
      quantity: p.quantity,
      avgPrice: p.avgPrice,
      currentPrice: p.currentPrice,
      unrealizedPnL: p.profitLoss,
      unrealizedRate: p.profitRate,
      strategy: p.strategy,
      market: p.market,
      highSinceEntry: p.highSinceEntry,
      stopLossPrice: p.stopLossPrice,
      trailingStopPrice: p.trailingStopPrice,
      entryATR: p.entryATR,
      partialExitCount: p.partialExitCount,
      realizedPnL: p.realizedPnL,
    }));

    // ── 9. 응답 구성 ──
    return NextResponse.json({
      success: true,
      summary: {
        // 기본 통계
        totalTrades,
        buyCount: buyTrades.length,
        sellCount: sellTrades.length,
        matchedTradeCount: realizedTrades.length,
        winCount: winTrades.length,
        lossCount: lossTrades.length,
        evenCount: evenTrades.length,
        // 승률/손익비/기대값 (% 기반)
        winRate: parseFloat(winRate.toFixed(2)),
        avgProfitRate: parseFloat(avgWinRate.toFixed(2)),
        avgLossRate: parseFloat(avgLossRate.toFixed(2)),
        profitFactor: profitFactor === Infinity ? 'Infinity' : parseFloat(profitFactor.toFixed(2)),
        expectedValue: parseFloat(expectedValue.toFixed(2)),
        // 절대금액 기반 평균 수익/손실 (통화별)
        avgWinAmountKRW: parseFloat(avgWinAmountKRW.toFixed(0)),
        avgLossAmountKRW: parseFloat(avgLossAmountKRW.toFixed(0)),
        avgWinAmountUSD: parseFloat(avgWinAmountUSD.toFixed(2)),
        avgLossAmountUSD: parseFloat(avgLossAmountUSD.toFixed(2)),
        // 누적 손익 / MDD
        maxDrawdown: parseFloat(maxDrawdown.toFixed(0)),
        totalRealizedPnL: parseFloat(cumulativePnL.toFixed(0)),
        // 미청산 포지션
        openPositionCount: positions.length,
        openPositionUnrealizedPnL: parseFloat(
          positions.reduce((sum, p) => sum + (p.profitLoss || 0), 0).toFixed(0)
        ),
      },
      // 청산 사유별 손익 (TRAILING_STOP / STOP_LOSS / TAKE_PROFIT / SIGNAL / UNKNOWN)
      exitReasonPerformance,
      stockPerformance,
      strategyPerformance,
      openPositions,
      recentTrades: allTrades.slice(-20).map(t => ({
        stockCode: t.stockCode,
        stockName: t.stockName,
        tradeType: t.tradeType,
        quantity: t.quantity,
        price: t.price,
        strategy: t.strategy,
        status: t.status,
        orderExecutionMode: t.orderExecutionMode,
        market: t.market,
        tradedAt: t.tradedAt,
      })),
    });
  } catch (error) {
    console.error('[PerformanceSummary] 오류:', error);
    return NextResponse.json(
      { success: false, error: `성과 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
