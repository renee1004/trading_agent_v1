// 계좌 잔고 조회 라우트

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';

export async function GET() {
  try {
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

        const balance = await client.getAccountBalance();
        return NextResponse.json({ success: true, data: balance, source: 'api' });
      } catch {
        // API 실패 시 모의 데이터
      }
    }

    // 모의 잔고 데이터
    const mockBalance = {
      totalDeposit: 50000000,
      totalEvaluation: 52300000,
      totalProfitLoss: 2300000,
      totalProfitRate: 4.6,
      availableAmount: 35000000,
      positions: [
        {
          stockCode: '005930',
          stockName: '삼성전자',
          quantity: 10,
          avgPrice: 72000,
          currentPrice: 78500,
          profitLoss: 65000,
          profitRate: 9.03,
          evaluationAmount: 785000,
        },
        {
          stockCode: '035420',
          stockName: 'NAVER',
          quantity: 5,
          avgPrice: 185000,
          currentPrice: 192000,
          profitLoss: 35000,
          profitRate: 3.78,
          evaluationAmount: 960000,
        },
        {
          stockCode: '000660',
          stockName: 'SK하이닉스',
          quantity: 8,
          avgPrice: 125000,
          currentPrice: 131000,
          profitLoss: 48000,
          profitRate: 4.8,
          evaluationAmount: 1048000,
        },
      ],
    };

    return NextResponse.json({ success: true, data: mockBalance, source: 'mock' });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '잔고 조회 실패' },
      { status: 500 }
    );
  }
}
