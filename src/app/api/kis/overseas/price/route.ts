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

    // 모의 데이터
    const stockNames: Record<string, string> = {
      'AAPL': '애플',
      'MSFT': '마이크로소프트',
      'GOOGL': '알파벳',
      'AMZN': '아마존',
      'NVDA': '엔비디아',
      'TSLA': '테슬라',
      'META': '메타',
      'NFLX': '넷플릭스',
      'AMD': 'AMD',
      'INTC': '인텔',
      'CRM': '세일즈포스',
      'ORCL': '오라클',
      'COST': '코스트코',
      'AVGO': '브로드컴',
      'PYPL': '페이팔',
    };
    
    const mockPrice = KisApiClient.generateMockOverseasPrice(
      stockCode,
      stockNames[stockCode] || stockCode,
      exchangeCode
    );
    
    return NextResponse.json({ success: true, data: mockPrice, source: 'mock' });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '해외주식 시세 조회 실패' },
      { status: 500 }
    );
  }
}
