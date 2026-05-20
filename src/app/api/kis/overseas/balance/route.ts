// 해외주식 잔고 조회 라우트

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
        return NextResponse.json({ success: true, data: balance, source: 'api' });
      } catch {
        // API 실패 시 모의 데이터
      }
    }

    // 모의 잔고 데이터
    const mockBalance = KisApiClient.generateMockOverseasBalance();

    return NextResponse.json({ success: true, data: mockBalance, source: 'mock' });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '해외주식 잔고 조회 실패' },
      { status: 500 }
    );
  }
}
