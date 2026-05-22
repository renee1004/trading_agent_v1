// 계좌 잔고 조회 라우트
// KisApiClient.getAccountBalance() 사용 (단일 진실 공급원)
// DB + 환경변수 fallback 지원
// KIS 설정만 있으면 자동으로 토큰을 확보한 뒤 잔고 조회

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';
import { getOrCreateKisConfigFromEnv } from '@/lib/kis-config-loader';

export async function GET() {
  try {
    // 공통 로더 사용: DB + env fallback
    const config = await getOrCreateKisConfigFromEnv();

    // KIS 설정 자체가 없으면 명확한 에러 반환 (0원 mock이 아님)
    if (!config) {
      return NextResponse.json(
        {
          success: false,
          error: 'KIS 설정이 없습니다. KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NO 또는 KIS_ACCOUNT 환경변수를 확인하세요.',
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
      const balance = await client.getAccountBalance();

      // 잔고 조회 성공 후 새 토큰이 발급되었으면 DB에 저장
      // (ensureToken이 자동 갱신한 토큰이 DB에 반영되지 않는 문제 방지)
      const tokenInfo = client.getTokenInfo();
      if (tokenInfo.accessToken && tokenInfo.tokenExpiresAt) {
        const dbConfig = await db.kisConfig.findFirst();
        if (dbConfig) {
          await db.kisConfig.update({
            where: { id: dbConfig.id },
            data: {
              accessToken: tokenInfo.accessToken,
              tokenExpiresAt: tokenInfo.tokenExpiresAt,
            },
          }).catch(err => {
            console.warn('[KIS Balance] 토큰 DB 저장 실패 (무시):', err);
          });
        }
      }

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

      // KIS API 에러 종류별 명확한 메시지
      let errorMessage = apiError.message || 'KIS 잔고 조회 실패';
      let errorCode = 'BALANCE_API_ERROR';

      if (errorMessage.includes('토큰 발급 실패')) {
        errorCode = 'TOKEN_ISSUE_FAILED';
        errorMessage = `KIS 토큰 발급 실패: ${errorMessage}`;
      } else if (errorMessage.includes('잔고 조회 에러')) {
        errorCode = 'BALANCE_QUERY_FAILED';
        // 계좌번호 관련 에러 가능성 안내
        errorMessage = `${errorMessage} (계좌번호 또는 상품코드 확인 필요)`;
      }

      return NextResponse.json(
        { success: false, error: errorMessage, code: errorCode, source: 'api' },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error('[KIS Balance] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: '잔고 조회 실패' },
      { status: 500 }
    );
  }
}
