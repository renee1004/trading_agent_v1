// 해외주식 잔고 조회 라우트
// KisApiClient.getOverseasAccountBalance() 사용 (단일 진실 공급원)

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

        const balance = await client.getOverseasAccountBalance();
        console.log('[KIS Overseas Balance] API success - totalDeposit:', balance.totalDeposit, 'positions:', balance.positions.length);
        return NextResponse.json({ success: true, data: balance, source: 'api' });
      } catch (apiError: any) {
        console.error('[KIS Overseas Balance] API failed:', apiError.message || apiError);
        return NextResponse.json(
          { success: false, error: apiError.message || 'KIS 해외 잔고 조회 실패', source: 'api' },
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
    console.error('[KIS Overseas Balance] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: '해외주식 잔고 조회 실패' },
      { status: 500 }
    );
  }
}
