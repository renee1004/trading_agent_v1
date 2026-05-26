import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';
import { TradingEngine } from '@/lib/trading-engine';
import { RiskManager } from '@/lib/risk-manager';
import { getMarketRiskConfig } from '@/lib/market-defaults';
import { BalanceItem } from '@/lib/types';

function makeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET() {
  try {
    const config = await db.kisConfig.findFirst();
    const recentTrades = await db.tradeHistory.findMany({
      orderBy: { tradedAt: 'desc' },
      take: 10,
    });

    const recentLogs = await db.agentLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    if (!config) {
      return NextResponse.json({
        success: true,
        diagnosis: 'NO_KIS_CONFIG',
        message: 'KIS 설정이 없어 실제 주문 진단을 할 수 없습니다.',
        recentTrades,
        recentLogs,
      });
    }

    const client = new KisApiClient({
      appKey: config.appKey,
      appSecret: config.appSecret,
      accountNo: config.accountNo,
      isDemo: config.isDemo,
      accessToken: config.accessToken || undefined,
      tokenExpiresAt: config.tokenExpiresAt ?? undefined,
    });

    try {
      await client.ensureToken();
    } catch (error) {
      return NextResponse.json({
        success: true,
        diagnosis: 'KIS_TOKEN_ERROR',
        message: makeErrorMessage(error),
        isDemo: config.isDemo,
        recentTrades,
        recentLogs,
      });
    }

    const watchlist = await db.watchlistItem.findMany({
      where: { isActive: true, market: 'DOMESTIC' },
      take: 20,
    });

    const targets = watchlist.length > 0
      ? watchlist.map(item => ({ code: item.stockCode, name: item.stockName }))
      : [
          { code: '005930', name: '삼성전자' },
          { code: '000660', name: 'SK하이닉스' },
          { code: '373220', name: 'LG에너지솔루션' },
          { code: '005380', name: '현대차' },
          { code: '035420', name: 'NAVER' },
        ];

    let accountBalance = 0;
    let positions: BalanceItem[] = [];
    try {
      const balance = await client.getAccountBalance();
      accountBalance = balance.availableAmount || balance.totalEvaluation || balance.totalDeposit || 0;
      positions = balance.positions || [];
    } catch (error) {
      return NextResponse.json({
        success: true,
        diagnosis: 'BALANCE_ERROR',
        message: makeErrorMessage(error),
        isDemo: config.isDemo,
        recentTrades,
        recentLogs,
      });
    }

    const riskManager = new RiskManager(getMarketRiskConfig('DOMESTIC'), 'DOMESTIC');
    const results = [];

    for (const target of targets) {
      try {
        const candles = await client.getStockDailyCandles(target.code, '3M');
        if (candles.length < 30) {
          results.push({
            stockCode: target.code,
            stockName: target.name,
            status: 'NO_TRADE',
            reason: `캔들 데이터 부족: ${candles.length}개`,
          });
          continue;
        }

        const signal = TradingEngine.analyze(candles, target.code, target.name, 'ALL', 'DOMESTIC');
        const riskCheck = signal.signalType === 'HOLD'
          ? { allowed: false, reason: 'HOLD 신호라 주문 대상 아님' }
          : riskManager.canTrade(signal, positions, accountBalance);

        results.push({
          stockCode: target.code,
          stockName: target.name,
          status: signal.signalType === 'HOLD'
            ? 'HOLD'
            : riskCheck.allowed
              ? 'ORDER_READY'
              : 'RISK_BLOCKED',
          signalType: signal.signalType,
          confidence: signal.confidence,
          price: signal.price,
          strategy: signal.strategy,
          signalReason: signal.reason,
          riskAllowed: riskCheck.allowed,
          riskReason: riskCheck.reason,
        });
      } catch (error) {
        results.push({
          stockCode: target.code,
          stockName: target.name,
          status: 'ERROR',
          reason: makeErrorMessage(error),
        });
      }
    }

    const summary = {
      totalTargets: results.length,
      holdCount: results.filter(item => item.status === 'HOLD').length,
      orderReadyCount: results.filter(item => item.status === 'ORDER_READY').length,
      riskBlockedCount: results.filter(item => item.status === 'RISK_BLOCKED').length,
      errorCount: results.filter(item => item.status === 'ERROR').length,
      recentTradeCount: recentTrades.length,
    };

    return NextResponse.json({
      success: true,
      diagnosis: summary.orderReadyCount > 0 ? 'ORDER_READY_EXISTS' : 'NO_ORDER_READY_SIGNAL',
      isDemo: config.isDemo,
      accountBalance,
      openPositions: positions.length,
      summary,
      results,
      recentTrades,
      recentLogs,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: makeErrorMessage(error) },
      { status: 500 }
    );
  }
}
