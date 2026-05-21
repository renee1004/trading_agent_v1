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
    console.log(`[KIS Token] App Secret length: ${(config.appSecret || '').length}`);

    // KIS API 클라이언트 동적 임포트
    const { KisApiClient } = await import('@/lib/kis-api');
    
    const client = new KisApiClient({
      appKey: config.appKey,
      appSecret: config.appSecret,
      accountNo: config.accountNo,
      isDemo: config.isDemo,
    });

    const token = await client.issueToken();

    // 토큰 정보 DB 업데이트
    await db.kisConfig.update({
      where: { id: config.id },
      data: {
        accessToken: token,
        tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    console.log('[KIS Token] Token issued successfully');
    return NextResponse.json({ 
      success: true, 
      data: { 
        tokenIssued: true,
        expiresIn: '24시간',
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

    return NextResponse.json({ 
      success: true, 
      data: { 
        configured: true,
        hasToken: !!hasValidToken,
        isDemo: config.isDemo,
        tokenExpiresAt: config.tokenExpiresAt,
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
