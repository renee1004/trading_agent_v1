// 매매 신호 분석 라우트
// 국내주식 + 해외주식 지원

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
      market = 'DOMESTIC',
      exchangeCode,
      params = {} 
    }: {
      stockCode: string;
      stockName: string;
      strategy?: string;
      market?: string;
      exchangeCode?: string;
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
      if (market === 'OVERSEAS') {
        candles = KisApiClient.generateMockOverseasCandles(120);
      } else {
        candles = KisApiClient.generateMockCandles(120);
      }
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
        market,
        exchangeCode,
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

// 관심종목 일괄 분석 (국내 + 해외)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const strategy = searchParams.get('strategy') || 'ALL';
    const market = searchParams.get('market') || 'ALL'; // ALL, DOMESTIC, OVERSEAS

    // 국내 관심종목
    const domesticStocks = [
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

    // 해외 관심종목
    const overseasStocks = [
      { code: 'AAPL', name: '애플', exchange: 'NAS' },
      { code: 'NVDA', name: '엔비디아', exchange: 'NAS' },
      { code: 'MSFT', name: '마이크로소프트', exchange: 'NAS' },
      { code: 'GOOGL', name: '알파벳', exchange: 'NAS' },
      { code: 'AMZN', name: '아마존', exchange: 'NAS' },
      { code: 'TSLA', name: '테슬라', exchange: 'NAS' },
      { code: 'META', name: '메타', exchange: 'NAS' },
      { code: 'NFLX', name: '넷플릭스', exchange: 'NAS' },
      { code: 'AMD', name: 'AMD', exchange: 'NAS' },
      { code: 'AVGO', name: '브로드컴', exchange: 'NAS' },
    ];

    const signals = [];

    // 국내 분석
    if (market === 'ALL' || market === 'DOMESTIC') {
      for (const stock of domesticStocks) {
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
          market: 'DOMESTIC',
          timestamp: signal.timestamp.toISOString(),
        });
      }
    }

    // 해외 분석
    if (market === 'ALL' || market === 'OVERSEAS') {
      for (const stock of overseasStocks) {
        const candles = KisApiClient.generateMockOverseasCandles(120);
        
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
          market: 'OVERSEAS',
          exchangeCode: stock.exchange,
          timestamp: signal.timestamp.toISOString(),
        });
      }
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
        domesticSignals: signals.filter(s => (s as Record<string, unknown>).market === 'DOMESTIC').length,
        overseasSignals: signals.filter(s => (s as Record<string, unknown>).market === 'OVERSEAS').length,
      }
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '일괄 분석 실패' },
      { status: 500 }
    );
  }
}
