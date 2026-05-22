// 해외주식 시세 조회 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const stockCode = searchParams.get('code') || 'AAPL';
    const exchangeCode = searchParams.get('exchange') || 'NAS';

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

        const price = await client.getOverseasStockPrice(stockCode, exchangeCode);
        return NextResponse.json({ success: true, data: price, source: 'api' });
      } catch {
        // API 실패 시 모의 데이터 반환
      }
    }

    // KIS API 미연결 - 시세 데이터 없음
    return NextResponse.json(
      { success: false, error: 'KIS API 미연결: 토큰을 먼저 발급받으세요.', source: 'mock' },
      { status: 403 }
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '해외주식 시세 조회 실패' },
      { status: 500 }
    );
  }
}
