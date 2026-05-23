// 해외주식 시세 조회 라우트
// 종목 마스터 기반 정규화 적용: "NVDA" → "NAS:NVDA", "SPY" → "AMS:SPY", "IBM" → "NYS:IBM"

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';
import { normalizeOverseasStockCode } from '@/lib/stock-master';
import type { OverseasExchangeCode } from '@/lib/kis-overseas-master';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const stockCode = searchParams.get('code') || 'AAPL';
    const exchangeCode = searchParams.get('exchange') || 'NAS';

    // 종목 마스터로 정규화 (순수 심볼도 올바른 거래소 코드로 매핑)
    const normalized = normalizeOverseasStockCode(stockCode, exchangeCode as OverseasExchangeCode);

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

        // 정규화된 symbol과 exchangeCode로 API 호출
        const price = await client.getOverseasStockPrice(
          normalized.symbol,
          normalized.exchangeCode as OverseasExchangeCode,
        );

        return NextResponse.json({
          success: true,
          data: price,
          normalized: {
            original: stockCode,
            displayCode: normalized.displayCode,
            exchangeCode: normalized.exchangeCode,
            symbol: normalized.symbol,
            stockName: normalized.stockName,
            source: normalized.source,
          },
          source: 'api',
        });
      } catch (apiError: any) {
        // API 실패 시에도 정규화 정보는 반환
        return NextResponse.json(
          {
            success: false,
            error: apiError?.message || '해외주식 시세 조회 실패',
            normalized: {
              original: stockCode,
              displayCode: normalized.displayCode,
              exchangeCode: normalized.exchangeCode,
              symbol: normalized.symbol,
              stockName: normalized.stockName,
              source: normalized.source,
            },
            source: 'master_only',
          },
          { status: 502 },
        );
      }
    }

    // KIS API 미연결 - 정규화 정보만 반환
    return NextResponse.json(
      {
        success: false,
        error: 'KIS API 미연결: 토큰을 먼저 발급받으세요.',
        normalized: {
          original: stockCode,
          displayCode: normalized.displayCode,
          exchangeCode: normalized.exchangeCode,
          symbol: normalized.symbol,
          stockName: normalized.stockName,
          source: normalized.source,
        },
        source: 'master_only',
      },
      { status: 403 },
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '해외주식 시세 조회 실패' },
      { status: 500 },
    );
  }
}
