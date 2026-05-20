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
        return NextResponse.json({ success: true, data: price, source: 'api' });
      } catch {
        // API 실패 시 모의 데이터 반환
      }
    }

    // 모의 데이터
    const stockNames: Record<string, string> = {
      '005930': '삼성전자',
      '000660': 'SK하이닉스',
      '373220': 'LG에너지솔루션',
      '006400': '삼성SDI',
      '051910': 'LG화학',
      '005380': '현대차',
      '035420': 'NAVER',
      '055550': '신한지주',
      '003670': '포스코홀딩스',
      '068270': '셀트리온',
    };
    
    const mockPrice = KisApiClient.generateMockPrice(
      stockCode, 
      stockNames[stockCode] || `종목${stockCode}`
    );
    
    return NextResponse.json({ success: true, data: mockPrice, source: 'mock' });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '시세 조회 실패' },
      { status: 500 }
    );
  }
}
