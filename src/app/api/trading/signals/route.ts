// 매매 신호 분석 라우트
// 국내주식 + 해외주식 지원
// 실제 KIS API 캔들 데이터 우선, 실패 시 모의 데이터 사용

import { NextRequest, NextResponse } from 'next/server';
import { KisApiClient } from '@/lib/kis-api';
import { TradingEngine } from '@/lib/trading-engine';
import { StrategyParameters, MarketType } from '@/lib/types';
import { db } from '@/lib/db';

/**
 * KIS 설정 로드 후 캔들 데이터 조회 (실데이터 우선)
 */
async function fetchCandlesWithFallback(
  stockCode: string,
  market: string,
  exchangeCode?: string
) {
  // KIS 설정 확인
  const config = await db.kisConfig.findFirst();
  let useRealData = false;

  if (config?.accessToken) {
    try {
      const client = new KisApiClient({
        appKey: config.appKey,
        appSecret: config.appSecret,
        accountNo: config.accountNo,
        isDemo: config.isDemo,
        accessToken: config.accessToken,
        tokenExpiresAt: config.tokenExpiresAt ?? undefined,
      });

      if (market === 'OVERSEAS' && exchangeCode) {
        const overseasCandles = await client.getOverseasDailyCandles(stockCode, exchangeCode, '3M');
        // OverseasStockCandle → StockCandle 변환
        return overseasCandles.map(c => ({
          date: c.date,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        }));
      } else {
        return await client.getStockDailyCandles(stockCode, '3M');
      }
    } catch {
      useRealData = false;
    }
  }

  // 모의 데이터 폴백
  if (market === 'OVERSEAS') {
    return KisApiClient.generateMockOverseasCandles(120).map(c => ({
      date: c.date,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }
  return KisApiClient.generateMockCandles(120);
}

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

    // 캔들 데이터 (실제 API 우선 → 모의 데이터 폴백)
    const candles = await fetchCandlesWithFallback(stockCode, market, exchangeCode);

    // 전략별 분석 (시장별 파라미터 자동 적용)
    const marketType = (market === 'OVERSEAS' ? 'OVERSEAS' : 'DOMESTIC') as MarketType;
    const signal = TradingEngine.analyze(candles, stockCode, stockName, strategy, marketType, params);

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
      { success: false, error: `분석 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
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

    // DB에서 관심종목 로드
    const watchlist = await db.watchlistItem.findMany({
      where: { isActive: true },
    });

    // 관심종목이 없으면 기본 종목
    const domesticStocks = watchlist.filter(w => w.market === 'DOMESTIC').length > 0
      ? watchlist.filter(w => w.market === 'DOMESTIC').map(w => ({ code: w.stockCode, name: w.stockName }))
      : [
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

    const overseasStocks = watchlist.filter(w => w.market === 'OVERSEAS').length > 0
      ? watchlist.filter(w => w.market === 'OVERSEAS').map(w => ({ 
          code: w.stockCode, name: w.stockName, exchange: w.exchangeCode || 'NAS' 
        }))
      : [
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
        try {
          const candles = await fetchCandlesWithFallback(stock.code, 'DOMESTIC');
          const signal = TradingEngine.analyze(candles, stock.code, stock.name, strategy, 'DOMESTIC');
          signals.push({
            ...signal,
            market: 'DOMESTIC',
            timestamp: signal.timestamp.toISOString(),
          });
        } catch {
          // 개별 종목 분석 실패 시 스킵
        }
      }
    }

    // 해외 분석
    if (market === 'ALL' || market === 'OVERSEAS') {
      for (const stock of overseasStocks) {
        try {
          const candles = await fetchCandlesWithFallback(stock.code, 'OVERSEAS', stock.exchange);
          const signal = TradingEngine.analyze(candles, stock.code, stock.name, strategy, 'OVERSEAS');
          signals.push({
            ...signal,
            market: 'OVERSEAS',
            exchangeCode: stock.exchange,
            timestamp: signal.timestamp.toISOString(),
          });
        } catch {
          // 개별 종목 분석 실패 시 스킵
        }
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
      { success: false, error: `일괄 분석 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
