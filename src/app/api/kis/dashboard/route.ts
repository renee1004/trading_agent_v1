// 대시보드 종목 리스트 시세 조회 라우트
// stock-master.ts 기반 종목 정규화 + Promise.allSettled 안정 조회
// 한 종목 실패가 전체 대시보드를 깨지 않음

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';
import {
  normalizeDashboardStockCodes,
  dedupeStockMasterItems,
  type StockMasterItem,
} from '@/lib/stock-master';
import type { OverseasExchangeCode } from '@/lib/kis-overseas-master';

interface DashboardQuoteRow {
  market: 'DOMESTIC' | 'OVERSEAS' | 'UNKNOWN';
  exchangeCode: string;
  symbol: string;
  displayCode: string;
  stockName: string;
  currency: 'KRW' | 'USD';
  source: string;
  quoteStatus: 'OK' | 'FAILED' | 'PENDING';
  currentPrice: number | null;
  previousClose: number | null;
  changePrice: number | null;
  changeRate: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  volume: number | null;
  quoteError: string | null;
  currentPriceField: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const codesParam = searchParams.get('codes') || '';

    // codes 파라미터 파싱 (쉼표로 구분된 종목코드 목록)
    const rawCodes = codesParam
      .split(',')
      .map(c => c.trim())
      .filter(Boolean);

    if (rawCodes.length === 0) {
      return NextResponse.json({
        success: true,
        data: [],
        total: 0,
      });
    }

    // 종목 마스터 기반 정규화 + 중복 제거
    const dashboardSymbols = dedupeStockMasterItems(
      normalizeDashboardStockCodes(rawCodes),
    );

    // KIS 설정 로드
    const config = await db.kisConfig.findFirst();

    if (!config?.accessToken) {
      // KIS API 미연결 - 정규화된 종목 정보만 반환 (시세 없음)
      const rows: DashboardQuoteRow[] = dashboardSymbols.map(item => ({
        ...item,
        quoteStatus: 'PENDING' as const,
        currentPrice: null,
        previousClose: null,
        changePrice: null,
        changeRate: null,
        highPrice: null,
        lowPrice: null,
        volume: null,
        quoteError: 'KIS API 미연결',
        currentPriceField: null,
        stockName: item.stockName,
        source: 'MASTER_ONLY',
      }));

      return NextResponse.json({
        success: true,
        data: rows,
        total: rows.length,
        source: 'master_only',
      });
    }

    const client = new KisApiClient({
      appKey: config.appKey,
      appSecret: config.appSecret,
      accountNo: config.accountNo,
      isDemo: config.isDemo,
      accessToken: config.accessToken,
      tokenExpiresAt: config.tokenExpiresAt ?? undefined,
    });

    // Promise.allSettled: 한 종목 실패가 전체를 깨지 않음
    const quoteResults = await Promise.allSettled(
      dashboardSymbols.map(async (item) => {
        if (item.market === 'DOMESTIC') {
          return {
            type: 'domestic' as const,
            data: await client.getStockPrice(item.symbol),
          };
        }
        if (item.market === 'OVERSEAS') {
          return {
            type: 'overseas' as const,
            data: await client.getOverseasStockPrice(
              item.symbol,
              item.exchangeCode as OverseasExchangeCode,
            ),
          };
        }
        return null;
      }),
    );

    // 결과 매핑: 실패 종목도 카드 유지
    const rows: DashboardQuoteRow[] = dashboardSymbols.map((item, index) => {
      const result = quoteResults[index];

      if (result && result.status === 'fulfilled' && result.value) {
        const quote = result.value;

        if (quote.type === 'domestic') {
          const d = quote.data;
          return {
            ...item,
            quoteStatus: 'OK' as const,
            currentPrice: d.currentPrice || null,
            previousClose: d.previousClose || null,
            changePrice: d.changePrice || null,
            changeRate: d.changeRate || null,
            highPrice: d.highPrice || null,
            lowPrice: d.lowPrice || null,
            volume: d.volume || null,
            quoteError: null,
            currentPriceField: null,
            stockName: d.stockName || item.stockName,
            source: 'KIS_REST',
          };
        }

        if (quote.type === 'overseas') {
          const o = quote.data;
          return {
            ...item,
            quoteStatus: (o.currentPrice > 0 ? 'OK' : 'PENDING') as 'OK' | 'PENDING',
            currentPrice: o.currentPrice || null,
            previousClose: o.previousClose || null,
            changePrice: o.changePrice || null,
            changeRate: o.changeRate || null,
            highPrice: o.highPrice || null,
            lowPrice: o.lowPrice || null,
            volume: o.volume || null,
            quoteError: o.currentPrice > 0 ? null : '현재가 0 (장외시간 또는 데이터 없음)',
            currentPriceField: o.currentPriceField || null,
            stockName: o.stockName || item.stockName,
            source: 'KIS_REST',
          };
        }
      }

      // 실패 또는 null 결과 → 종목 카드는 유지, 에러 정보 표시
      const errorReason =
        result?.status === 'rejected'
          ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
          : '알 수 없는 시장';

      return {
        ...item,
        quoteStatus: 'FAILED' as const,
        currentPrice: null,
        previousClose: null,
        changePrice: null,
        changeRate: null,
        highPrice: null,
        lowPrice: null,
        volume: null,
        quoteError: errorReason,
        currentPriceField: null,
        stockName: item.stockName,
        source: 'MASTER_ONLY',
      };
    });

    return NextResponse.json({
      success: true,
      data: rows,
      total: rows.length,
      source: 'api',
    });
  } catch (error) {
    console.error('[Dashboard] 종목 시세 조회 실패:', error);
    return NextResponse.json(
      { success: false, error: '대시보드 시세 조회 실패' },
      { status: 500 },
    );
  }
}
