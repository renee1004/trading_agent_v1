// 주식 시세 조회 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const stockCode = searchParams.get('code') || '005930'; // 기본: 삼성전자

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

        const price = await client.getStockPrice(stockCode);
        console.log(`[KIS Price] API success - ${stockCode}: ${price.currentPrice}`);
        return NextResponse.json({ success: true, data: price, source: 'api' });
      } catch (apiError: any) {
        console.error(`[KIS Price] API failed for ${stockCode}, falling back to mock:`, apiError.message || apiError);
      }
    }

    // KIS API 미연결 - 시세 데이터 없음
    return NextResponse.json(
      { success: false, error: 'KIS API 미연결: 토큰을 먼저 발급받으세요.', source: 'mock' },
      { status: 403 }
    );
  } catch (error) {
    console.error('[KIS Price] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: '시세 조회 실패' },
      { status: 500 }
    );
  }
}
