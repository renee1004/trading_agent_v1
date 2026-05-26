// 매매 신호 분석 라우트
// 국내주식 + 해외주식 지원
// 실제 KIS API 캔들 데이터만 사용 (모의 데이터 사용 안함)
// 각 신호에 실시간 현재가 보강 (원본 Trading_Agent의 getDomesticPrice/getOverseasPrice 패턴 포팅)
// Promise.allSettled → 개별 실패 격리, 200ms 순차 지연 → KIS 속도제한 회피

import { NextRequest, NextResponse } from 'next/server';
import { KisApiClient } from '@/lib/kis-api';
import { TradingEngine } from '@/lib/trading-engine';
import { StrategyParameters, MarketType, PriceSource } from '@/lib/types';
import { db } from '@/lib/db';
import { getEffectiveTradingSettings } from '@/lib/effective-settings';
import {
  isKoreanSymbol,
  normalizeStockCode,
  getOverseasExchangeCode,
  stripOverseasExchangeSuffix,
  getOverseasExchangeCandidates,
  type OverseasExchangeCode,
} from '@/lib/stock-master';

/**
 * KIS 설정 로드 후 캔들 데이터 조회 (실데이터만)
 */
async function fetchCandlesWithFallback(
  stockCode: string,
  market: string,
  exchangeCode?: string
) {
  const config = await db.kisConfig.findFirst();

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
        return overseasCandles.map(c => ({
          date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        }));
      } else {
        return await client.getStockDailyCandles(stockCode, '3M');
      }
    } catch {
      // API 실패 시 빈 배열 반환
    }
  }

  // KIS 미연결 또는 API 실패 시 빈 배열 반환 (가짜 데이터 사용 안함)
  return [];
}

// ─── 실시간 현재가 보강 (원본 Trading_Agent 패턴 포팅) ──────────────

interface SignalWithMarket {
  stockCode: string;
  stockName: string;
  signalType: 'BUY' | 'SELL' | 'HOLD';
  strategy: string;
  confidence: number;
  price: number;
  reason: string;
  indicators: Record<string, number>;
  timestamp: string;
  market?: string;
  exchangeCode?: string;
  // 보강 필드
  currentPrice?: number;
  previousClose?: number;
  changePrice?: number;
  changeRate?: number;
  currency?: 'KRW' | 'USD';
  quoteStatus?: 'OK' | 'FAILED' | 'PENDING' | 'DELAYED';
  quoteTimestamp?: string;
  quoteError?: string;
  priceSource?: PriceSource;
  priceSourceLabel?: string;
}

/**
 * 국내 현재가 보강 (원본: getDomesticPrice 패턴)
 * - KIS FHKST01010100 → { price, change, priceSource: "REALTIME" }
 */
async function enrichDomesticQuote(
  signal: SignalWithMarket,
  client: KisApiClient
): Promise<SignalWithMarket> {
  try {
    const code = normalizeStockCode(signal.stockCode);
    const quote = await client.getStockPrice(code);
    return {
      ...signal,
      currentPrice: quote.currentPrice,
      previousClose: quote.previousClose,
      changePrice: quote.changePrice,
      changeRate: quote.changeRate,
      currency: 'KRW',
      quoteStatus: 'OK',
      quoteTimestamp: new Date().toISOString(),
      priceSource: 'REALTIME',
      priceSourceLabel: '실시간',
    };
  } catch (error) {
    return {
      ...signal,
      currency: 'KRW',
      quoteStatus: 'FAILED',
      quoteError: error instanceof Error ? error.message : 'Unknown',
    };
  }
}

/**
 * 해외 현재가 보강 (원본: getOverseasPrice 패턴)
 * - 거래소 자동 해석: 명시적 접미사 → 마스터 → EXCD_MAP → 기본 NAS
 * - 거래소 후보 순차 시도: NAS → NYS → AMS
 * - 전부 실패 시 DAILY_FALLBACK (원본: buildFallbackPriceFromOhlcv)
 */
async function enrichOverseasQuote(
  signal: SignalWithMarket,
  client: KisApiClient
): Promise<SignalWithMarket> {
  const symbol = stripOverseasExchangeSuffix(signal.stockCode);
  const candidates = getOverseasExchangeCandidates(signal.stockCode);
  const errors: string[] = [];

  // 거래소 후보 순차 시도 (원본: getOverseasPrice의 candidates 루프)
  for (const excd of candidates) {
    try {
      const quote = await client.getOverseasStockPrice(symbol, excd);
      return {
        ...signal,
        stockCode: symbol, // 순수 심볼로 정규화
        currentPrice: quote.currentPrice,
        previousClose: quote.previousClose,
        changePrice: quote.changePrice,
        changeRate: quote.changeRate,
        currency: 'USD',
        exchangeCode: excd,
        quoteStatus: 'OK',
        quoteTimestamp: new Date().toISOString(),
        priceSource: 'REALTIME',
        priceSourceLabel: '실시간',
      };
    } catch (error) {
      errors.push(`${excd}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 모든 거래소 시도 실패 → FAILED 상태로 표시
  return {
    ...signal,
    stockCode: symbol,
    currency: 'USD',
    exchangeCode: signal.exchangeCode || getOverseasExchangeCode(signal.stockCode),
    quoteStatus: 'FAILED',
    quoteError: `해외 현재가 조회 실패 (${errors.join(' / ')})`,
  };
}

/**
 * 개별 신호에 실시간 현재가를 보강합니다.
 * 원본 Trading_Agent의 isKorean(symbol) → getDomesticPrice / getOverseasPrice 패턴 포팅
 */
async function enrichSignalWithQuote(
  signal: SignalWithMarket,
  client: KisApiClient | null
): Promise<SignalWithMarket> {
  // KIS 클라이언트가 없으면 PENDING 상태
  if (!client) {
    const isDomestic = signal.market === 'DOMESTIC' || isKoreanSymbol(signal.stockCode);
    return {
      ...signal,
      currency: isDomestic ? 'KRW' : 'USD',
      quoteStatus: 'PENDING',
    };
  }

  // 국내/해외 자동 판별 (원본: isKorean)
  const isDomestic = signal.market === 'DOMESTIC' || isKoreanSymbol(signal.stockCode);

  if (isDomestic) {
    return enrichDomesticQuote(signal, client);
  } else {
    return enrichOverseasQuote(signal, client);
  }
}

/**
 * 여러 신호에 실시간 현재가를 보강합니다.
 * - KIS 설정 1회만 조회
 * - Promise.allSettled로 개별 실패 격리
 * - 200ms 순차 지연으로 KIS 속도제한 회피 (원본: ad-hoc setTimeout 패턴)
 */
async function enrichSignalsWithQuotes(
  signals: SignalWithMarket[]
): Promise<SignalWithMarket[]> {
  if (signals.length === 0) return signals;

  // KIS 설정 1회만 조회
  const config = await db.kisConfig.findFirst();
  let client: KisApiClient | null = null;

  if (config?.accessToken) {
    try {
      client = new KisApiClient({
        appKey: config.appKey,
        appSecret: config.appSecret,
        accountNo: config.accountNo,
        isDemo: config.isDemo,
        accessToken: config.accessToken,
        tokenExpiresAt: config.tokenExpiresAt ?? undefined,
      });
    } catch {
      client = null;
    }
  }

  // 순차 호출: 200ms 간격 (KIS 속도제한 회피, 원본: 1000ms~1200ms 간격)
  const enrichPromises = signals.map((signal, index) =>
    new Promise<SignalWithMarket>(resolve => {
      setTimeout(() => {
        enrichSignalWithQuote(signal, client).then(resolve);
      }, index * 200);
    })
  );

  const results = await Promise.allSettled(enrichPromises);

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    return {
      ...signals[index],
      currency: signals[index].market === 'DOMESTIC' ? 'KRW' : 'USD',
      quoteStatus: 'FAILED' as const,
      quoteError: result.reason?.message || 'Unknown error',
    };
  });
}

// ─── POST: 단일 종목 분석 ─────────────────────────────────────────

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

    // 현재 전략 공격성 설정 로드 (에이전트와 동일한 임계값 사용)
    const { settings: effectiveSettings } = await getEffectiveTradingSettings();

    // 전략별 분석 (공격성 임계값 적용)
    const marketType = (market === 'OVERSEAS' ? 'OVERSEAS' : 'DOMESTIC') as MarketType;
    const signal = TradingEngine.analyze(candles, stockCode, stockName, strategy, marketType, params, effectiveSettings.signalThreshold, effectiveSettings.weakSignalThreshold);

    // 실시간 현재가 보강 (단일 종목)
    const signalWithMarket: SignalWithMarket = {
      ...signal,
      market,
      exchangeCode,
      timestamp: signal.timestamp.toISOString(),
    };

    const config = await db.kisConfig.findFirst();
    let client: KisApiClient | null = null;
    if (config?.accessToken) {
      try {
        client = new KisApiClient({
          appKey: config.appKey,
          appSecret: config.appSecret,
          accountNo: config.accountNo,
          isDemo: config.isDemo,
          accessToken: config.accessToken,
          tokenExpiresAt: config.tokenExpiresAt ?? undefined,
        });
      } catch {
        client = null;
      }
    }
    const enriched = await enrichSignalWithQuote(signalWithMarket, client);

    return NextResponse.json({
      success: true,
      data: enriched
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `분석 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

// ─── GET: 관심종목 일괄 분석 (국내 + 해외) ─────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const strategy = searchParams.get('strategy') || 'ALL';
    const market = searchParams.get('market') || 'ALL';

    // DB에서 관심종목 로드
    const watchlist = await db.watchlistItem.findMany({
      where: { isActive: true },
    });

    // 관심종목이 없으면 기본 국내 종목만 (해외는 관심종목에 있을 때만)
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

    // 해외주식은 관심종목에 있는 것만 분석 (기본값 없음)
    const overseasStocks = watchlist.filter(w => w.market === 'OVERSEAS').length > 0
      ? watchlist.filter(w => w.market === 'OVERSEAS').map(w => ({
          code: w.stockCode, name: w.stockName, exchange: w.exchangeCode || 'NAS'
        }))
      : []; // 관심종목에 해외주식이 없으면 빈 배열

    const signals: SignalWithMarket[] = [];

    // ── 현재 전략 공격성 설정 로드 (에이전트와 동일한 임계값 사용) ──
    const { settings: effectiveSettings } = await getEffectiveTradingSettings();
    const signalThreshold = effectiveSettings.signalThreshold;
    const weakSignalThreshold = effectiveSettings.weakSignalThreshold;

    // 국내 분석
    if (market === 'ALL' || market === 'DOMESTIC') {
      for (const stock of domesticStocks) {
        try {
          const candles = await fetchCandlesWithFallback(stock.code, 'DOMESTIC');
          const signal = TradingEngine.analyze(candles, stock.code, stock.name, strategy, 'DOMESTIC', {}, signalThreshold, weakSignalThreshold);
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
          const signal = TradingEngine.analyze(candles, stock.code, stock.name, strategy, 'OVERSEAS', {}, signalThreshold, weakSignalThreshold);
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

    // 실시간 현재가 보강
    const enrichedSignals = await enrichSignalsWithQuotes(signals);

    // 매수/매도 신호만 필터링
    const activeSignals = enrichedSignals.filter(s => s.signalType !== 'HOLD');

    return NextResponse.json({
      success: true,
      data: {
        allSignals: enrichedSignals,
        activeSignals,
        totalAnalyzed: enrichedSignals.length,
        buySignals: enrichedSignals.filter(s => s.signalType === 'BUY').length,
        sellSignals: enrichedSignals.filter(s => s.signalType === 'SELL').length,
        holdSignals: enrichedSignals.filter(s => s.signalType === 'HOLD').length,
        domesticSignals: enrichedSignals.filter(s => s.market === 'DOMESTIC').length,
        overseasSignals: enrichedSignals.filter(s => s.market === 'OVERSEAS').length,
        // ── 임계값 정보 (UI에서 신호 기준 표시용) ──
        thresholds: {
          strategyAggressiveness: effectiveSettings.strategyAggressiveness,
          signalThreshold,
          weakSignalThreshold,
          minConfidenceThreshold: effectiveSettings.minConfidenceThreshold,
        },
      }
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `일괄 분석 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
