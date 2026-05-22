// 해외주식 잔고 조회 라우트
// KisApiClient.getOverseasAccountBalance() 사용 (단일 진실 공급원)
// KIS 설정만 있으면 자동으로 토큰을 확보한 뒤 잔고 조회

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';

export async function GET() {
  try {
    const config = await db.kisConfig.findFirst();

    // KIS 설정 자체가 없으면 명확한 에러 반환
    if (!config) {
      return NextResponse.json(
        {
          success: false,
          error: 'KIS 설정이 없습니다. App Key, App Secret, 계좌번호를 먼저 저장해주세요.',
          code: 'NO_KIS_CONFIG',
        },
        { status: 400 }
      );
    }

    // KisApiClient 생성 — accessToken 없어도 내부 ensureToken()이 자동 발급
    const client = new KisApiClient({
      appKey: config.appKey,
      appSecret: config.appSecret,
      accountNo: config.accountNo,
      isDemo: config.isDemo,
      accessToken: config.accessToken || undefined,
      tokenExpiresAt: config.tokenExpiresAt ?? undefined,
    });

    try {
      const balance = await client.getOverseasAccountBalance();

      // 잔고 조회 성공 후 새 토큰이 발급되었으면 DB에 저장
      const tokenInfo = client.getTokenInfo();
      if (tokenInfo.accessToken && tokenInfo.tokenExpiresAt) {
        await db.kisConfig.update({
          where: { id: config.id },
          data: {
            accessToken: tokenInfo.accessToken,
            tokenExpiresAt: tokenInfo.tokenExpiresAt,
          },
        }).catch(err => {
          console.warn('[KIS Overseas Balance] 토큰 DB 저장 실패 (무시):', err);
        });
      }

      console.log('[KIS Overseas Balance] API success - totalDeposit:', balance.totalDeposit, 'positions:', balance.positions.length);
      return NextResponse.json({ success: true, data: balance, source: 'api' });
    } catch (apiError: any) {
      console.error('[KIS Overseas Balance] API failed:', apiError.message || apiError);

      let errorMessage = apiError.message || 'KIS 해외 잔고 조회 실패';
      let errorCode = 'BALANCE_API_ERROR';

      if (errorMessage.includes('토큰 발급 실패')) {
        errorCode = 'TOKEN_ISSUE_FAILED';
        errorMessage = `KIS 토큰 발급 실패: ${errorMessage}`;
      } else if (errorMessage.includes('잔고 조회 에러')) {
        errorCode = 'BALANCE_QUERY_FAILED';
        errorMessage = `${errorMessage} (계좌번호 또는 상품코드 확인 필요)`;
      }

      return NextResponse.json(
        { success: false, error: errorMessage, code: errorCode, source: 'api' },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error('[KIS Overseas Balance] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: '해외주식 잔고 조회 실패' },
      { status: 500 }
    );
  }
}
