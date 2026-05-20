// 매매 신호 분석 라우트

import { NextRequest, NextResponse } from 'next/server';
import { KisApiClient } from '@/lib/kis-api';
import { TradingEngine } from '@/lib/trading-engine';
import { StrategyParameters } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      stockCode, 
      stockName, 
      strategy = 'ALL',
      params = {} 
    }: {
      stockCode: string;
      stockName: string;
      strategy?: string;
      params?: StrategyParameters;
    } = body;

    if (!stockCode) {
      return NextResponse.json(
        { success: false, error: '종목코드 필요' },
        { status: 400 }
      );
    }

    // 캔들 데이터 (API 또는 모의)
    let candles;
    try {
      candles = KisApiClient.generateMockCandles(120);
    } catch {
      candles = KisApiClient.generateMockCandles(120);
    }

    // 전략별 분석
    let signal;
    switch (strategy) {
      case 'COMPOSITE':
        signal = TradingEngine.analyzeComposite(candles, stockCode, stockName, params);
        break;
      case 'VOLATILITY_BREAKOUT':
        signal = TradingEngine.analyzeVolatilityBreakout(candles, stockCode, stockName, params);
        break;
      case 'SUPER_TREND':
        signal = TradingEngine.analyzeSuperTrend(candles, stockCode, stockName, params);
        break;
      case 'MEAN_REVERSION':
        signal = TradingEngine.analyzeMeanReversion(candles, stockCode, stockName, params);
        break;
      case 'MOMENTUM':
        signal = TradingEngine.analyzeMomentum(candles, stockCode, stockName, params);
        break;
      case 'ALL':
      default:
        signal = TradingEngine.analyzeAllStrategies(candles, stockCode, stockName, params);
        break;
    }

    return NextResponse.json({ 
      success: true, 
      data: {
        ...signal,
        timestamp: signal.timestamp.toISOString(),
      }
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '분석 실패' },
      { status: 500 }
    );
  }
}

// 관심종목 일괄 분석
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const strategy = searchParams.get('strategy') || 'ALL';

    const watchlist = [
      { code: '005930', name: '삼성전자' },
      { code: '000660', name: 'SK하이닉스' },
      { code: '373220', name: 'LG에너지솔루션' },
      { code: '005380', name: '현대차' },
      { code: '035420', name: 'NAVER' },
      { code: '055550', name: '신한지주' },
      { code: '068270', name: '셀트리온' },
      { code: '006400', name: '삼성SDI' },
      { code: '051910', name: 'LG화학' },
      { code: '003670', name: '포스코홀딩스' },
    ];

    const signals = [];
    for (const stock of watchlist) {
      const candles = KisApiClient.generateMockCandles(120);
      
      let signal;
      switch (strategy) {
        case 'COMPOSITE':
          signal = TradingEngine.analyzeComposite(candles, stock.code, stock.name);
          break;
        case 'SUPER_TREND':
          signal = TradingEngine.analyzeSuperTrend(candles, stock.code, stock.name);
          break;
        case 'ALL':
        default:
          signal = TradingEngine.analyzeAllStrategies(candles, stock.code, stock.name);
          break;
      }
      
      signals.push({
        ...signal,
        timestamp: signal.timestamp.toISOString(),
      });
    }

    // 매수/매도 신호만 필터링
    const activeSignals = signals.filter(s => s.signalType !== 'HOLD');

    return NextResponse.json({ 
      success: true, 
      data: {
        allSignals: signals,
        activeSignals,
        totalAnalyzed: signals.length,
        buySignals: signals.filter(s => s.signalType === 'BUY').length,
        sellSignals: signals.filter(s => s.signalType === 'SELL').length,
        holdSignals: signals.filter(s => s.signalType === 'HOLD').length,
      }
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '일괄 분석 실패' },
      { status: 500 }
    );
  }
}
