// 주식 시세 조회 라우트
// 종목 마스터 기반 정규화 적용: "005930" → "KRX:005930", "KRX:005930" → "KRX:005930"

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';
import { normalizeDomesticStockCode, isDomesticStockCode } from '@/lib/stock-master';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const stockCode = searchParams.get('code') || '005930'; // 기본: 삼성전자

    // 국내 종목 정규화
    const normalized = isDomesticStockCode(stockCode)
      ? normalizeDomesticStockCode(stockCode)
      : null;

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

        // KIS API는 순수 6자리 코드만 사용
        const pureCode = normalized?.symbol || stockCode;
        const price = await client.getStockPrice(pureCode);
        console.log(`[KIS Price] API success - ${pureCode}: ${price.currentPrice}`);

        return NextResponse.json({
          success: true,
          data: price,
          normalized: normalized ? {
            original: stockCode,
            displayCode: normalized.displayCode,
            exchangeCode: normalized.exchangeCode,
            symbol: normalized.symbol,
            currency: normalized.currency,
          } : null,
          source: 'api',
        });
      } catch (apiError: any) {
        console.error(`[KIS Price] API failed for ${stockCode}:`, apiError.message || apiError);
        return NextResponse.json(
          {
            success: false,
            error: apiError?.message || '시세 조회 실패',
            normalized: normalized ? {
              original: stockCode,
              displayCode: normalized.displayCode,
              symbol: normalized.symbol,
            } : null,
            source: 'master_only',
          },
          { status: 502 },
        );
      }
    }

    // KIS API 미연결
    return NextResponse.json(
      { success: false, error: 'KIS API 미연결: 토큰을 먼저 발급받으세요.', source: 'mock' },
      { status: 403 },
    );
  } catch (error) {
    console.error('[KIS Price] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: '시세 조회 실패' },
      { status: 500 },
    );
  }
}
