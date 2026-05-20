// KIS 토큰 발급 라우트

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';

export async function POST() {
  try {
    const config = await db.kisConfig.findFirst();
    
    if (!config) {
      return NextResponse.json(
        { success: false, error: 'KIS API 설정이 없습니다. 먼저 설정을 등록해주세요.' },
        { status: 400 }
      );
    }

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

    return NextResponse.json({ 
      success: true, 
      data: { 
        tokenIssued: true,
        expiresIn: '24시간',
      }
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '토큰 발급 실패';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const config = await db.kisConfig.findFirst();
    
    if (!config) {
      return NextResponse.json({ 
        success: true, 
        data: { configured: false, hasToken: false }
      });
    }

    const hasValidToken = config.accessToken && config.tokenExpiresAt && config.tokenExpiresAt > new Date();

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
    return NextResponse.json(
      { success: false, error: '토큰 상태 조회 실패' },
      { status: 500 }
    );
  }
}
