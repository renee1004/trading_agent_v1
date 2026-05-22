// KIS 토큰 발급 라우트

import { NextResponse } from 'next/server';
import { db, getDbType } from '@/lib/db';

export async function POST() {
  try {
    console.log(`[KIS Token] POST request, DB type: ${getDbType()}`);
    
    const config = await db.kisConfig.findFirst();
    
    if (!config) {
      console.log('[KIS Token] No config found in DB');
      return NextResponse.json(
        { success: false, error: 'KIS API 설정이 없습니다. 먼저 설정을 등록해주세요.' },
        { status: 400 }
      );
    }

    console.log(`[KIS Token] Config found: appKey=${(config.appKey || '').substring(0, 8)}****, isDemo=${config.isDemo}, accountNo=${config.accountNo}`);

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
    await db.kisConfig.update({
      where: { id: config.id },
      data: {
        accessToken: token,
        tokenExpiresAt: tokenInfo.tokenExpiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

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
    
    const config = await db.kisConfig.findFirst();
    
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
