// 계좌 잔고 조회 라우트
// KisApiClient.getAccountBalance() 사용 (단일 진실 공급원)

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

        return NextResponse.json({
          success: true,
          data: {
            ...balance,
            cashAmount: balance.availableAmount,
          },
          source: 'api',
        });
      } catch (apiError: any) {
        console.error('[KIS Balance] API failed:', apiError.message || apiError);
        return NextResponse.json(
          { success: false, error: apiError.message || 'KIS 잔고 조회 실패', source: 'api' },
          { status: 502 }
        );
      }
    }

    // 토큰 미발급 시 - 0원으로 표시 (가짜 수익 방지)
    const mockBalance = {
      totalDeposit: 0,
      totalEvaluation: 0,
      totalProfitLoss: 0,
      totalProfitRate: 0,
      availableAmount: 0,
      positions: [],
    };

    return NextResponse.json({ success: true, data: mockBalance, source: 'mock' });
  } catch (error) {
    console.error('[KIS Balance] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: '잔고 조회 실패' },
      { status: 500 }
    );
  }
}
