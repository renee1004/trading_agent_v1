// KIS 토큰 발급 라우트
// DB + 환경변수 fallback 지원

import { NextResponse } from 'next/server';
import { db, getDbType } from '@/lib/db';
import { getOrCreateKisConfigFromEnv } from '@/lib/kis-config-loader';

export async function POST() {
  try {
    console.log(`[KIS Token] POST request, DB type: ${getDbType()}`);

    // 공통 로더 사용: DB + env fallback
    const config = await getOrCreateKisConfigFromEnv();

    if (!config) {
      console.log('[KIS Token] No config found in DB or env');
      return NextResponse.json(
        {
          success: false,
          error: 'KIS API 설정이 없습니다. KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NO 또는 KIS_ACCOUNT 환경변수를 확인하세요.',
        },
        { status: 400 }
      );
    }

    // DB 레코드 조회 (토큰 업데이트용)
    let dbConfig = await db.kisConfig.findFirst();

    console.log(`[KIS Token] Config found: appKey=${config.appKey.substring(0, 4)}****, isDemo=${config.isDemo}, accountNo=${config.accountNo}`);

    // 기존 토큰이 유효한지 먼저 확인 (5분 이상 남아있으면 재사용)
    // ensureToken()의 5분 버퍼와 동일한 기준으로 통일
    const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5분 버퍼
    if (config.accessToken && config.tokenExpiresAt) {
      const expiresAt = new Date(config.tokenExpiresAt);
      const now = new Date();
      const remainingMs = expiresAt.getTime() - now.getTime();
      // 5분 이상 남아있으면 기존 토큰 재사용 (불필요한 발급 방지)
      if (remainingMs > TOKEN_EXPIRY_BUFFER_MS) {
        console.log(`[KIS Token] Existing token is still valid (expires in ${Math.round(remainingMs / 60000)}min), reusing`);
        return NextResponse.json({
          success: true,
          data: {
            tokenIssued: true,
            expiresIn: `${Math.round(remainingMs / 3600000)}시간 ${Math.round((remainingMs % 3600000) / 60000)}분`,
            reused: true,
          }
        });
      }
      console.log(`[KIS Token] Existing token expired or about to expire (remaining: ${Math.round(remainingMs / 1000)}s), requesting new token`);
    }

    // KIS API 클라이언트 동적 임포트
    const { KisApiClient } = await import('@/lib/kis-api');

    const client = new KisApiClient({
      appKey: config.appKey,
      appSecret: config.appSecret,
      accountNo: config.accountNo,
      isDemo: config.isDemo,
      // DB에 저장된 토큰 전달 (서버 캐시 동기화)
      accessToken: config.accessToken || undefined,
      tokenExpiresAt: config.tokenExpiresAt ?? undefined,
    });

    const token = await client.issueToken();

    // getTokenInfo()로 실제 만료시간 획득 (KIS API 응답의 expires_in 기반)
    const tokenInfo = client.getTokenInfo();

    // 토큰 정보 DB 업데이트
    if (dbConfig) {
      try {
        await db.kisConfig.update({
          where: { id: dbConfig.id },
          data: {
            accessToken: token,
            tokenExpiresAt: tokenInfo.tokenExpiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
      } catch (dbErr) {
        console.warn('[KIS Token] 토큰 DB 저장 실패 (무시):', dbErr);
      }
    }

    // 남은 시간 계산 (실제 만료시간 기반)
    let expiresInStr = '24시간';
    if (tokenInfo.tokenExpiresAt) {
      const remainingMs = tokenInfo.tokenExpiresAt.getTime() - Date.now();
      const hours = Math.floor(remainingMs / 3600000);
      const minutes = Math.floor((remainingMs % 3600000) / 60000);
      expiresInStr = `${hours}시간 ${minutes}분`;
    }

    console.log('[KIS Token] Token issued successfully');
    return NextResponse.json({
      success: true,
      data: {
        tokenIssued: true,
        expiresIn: expiresInStr,
        reused: false,
      }
    });
  } catch (error: unknown) {
    console.error('[KIS Token] POST error:', error);
    const message = error instanceof Error ? error.message : '토큰 발급 실패';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    console.log(`[KIS Token] GET request, DB type: ${getDbType()}`);

    // 공통 로더 사용: DB + env fallback
    const config = await getOrCreateKisConfigFromEnv();

    if (!config) {
      return NextResponse.json({
        success: true,
        data: { configured: false, hasToken: false }
      });
    }

    const hasValidToken = config.accessToken && config.tokenExpiresAt && new Date(config.tokenExpiresAt) > new Date();

    // 남은 시간 계산
    let expiresInfo = '';
    if (hasValidToken && config.tokenExpiresAt) {
      const remainingMs = new Date(config.tokenExpiresAt).getTime() - Date.now();
      const hours = Math.floor(remainingMs / 3600000);
      const minutes = Math.floor((remainingMs % 3600000) / 60000);
      expiresInfo = `${hours}시간 ${minutes}분 남음`;
    }

    return NextResponse.json({
      success: true,
      data: {
        configured: true,
        hasToken: !!hasValidToken,
        isDemo: config.isDemo,
        tokenExpiresAt: config.tokenExpiresAt,
        expiresInfo,
      }
    });
  } catch (error) {
    console.error('[KIS Token] GET error:', error);
    return NextResponse.json(
      { success: false, error: '토큰 상태 조회 실패', detail: String(error) },
      { status: 500 }
    );
  }
}
