// KIS API 설정 관리 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db, getDbType } from '@/lib/db';

export async function GET() {
  try {
    console.log(`[KIS Config] GET request, DB type: ${getDbType()}`);
    
    const configs = await db.kisConfig.findMany();
    
    // appSecret 마스킹 처리
    const masked = configs.map((c: any) => ({
      id: c.id,
      appKey: c.appKey ? c.appKey.substring(0, 8) + '****' : '',
      accountNo: c.accountNo || '',
      isDemo: c.isDemo ?? true,
      tokenExpiresAt: c.tokenExpiresAt || null,
      accessToken: c.accessToken ? 'exists' : '',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    console.log(`[KIS Config] Found ${configs.length} config(s)`);
    return NextResponse.json({ success: true, data: masked });
  } catch (error) {
    console.error('[KIS Config] GET error:', error);
    return NextResponse.json(
      { success: false, error: '설정 조회 실패', detail: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { appKey, appSecret, accountNo, isDemo } = body;

    console.log(`[KIS Config] POST request, appKey: ${appKey ? 'provided' : 'empty'}, accountNo: ${accountNo || 'empty'}`);

    // 기존 설정 조회
    let existing: any = null;
    try {
      existing = await db.kisConfig.findFirst();
    } catch (e) {
      console.warn('[KIS Config] findFirst failed, treating as no existing config:', e);
    }

    // 수정 모드: appSecret이 빈칸이면 기존 값 유지
    const finalAppKey = appKey || existing?.appKey;
    const finalAppSecret = appSecret || existing?.appSecret;
    const finalAccountNo = accountNo || existing?.accountNo;

    if (!finalAppKey || !finalAppSecret || !finalAccountNo) {
      return NextResponse.json(
        { success: false, error: '필수 항목 누락 (App Key, App Secret, 계좌번호)' },
        { status: 400 }
      );
    }

    // 기존 설정 삭제 후 재생성
    if (existing) {
      try {
        await db.kisConfig.delete({ where: { id: existing.id } });
      } catch (e) {
        console.warn('[KIS Config] delete failed, trying deleteMany:', e);
        await db.kisConfig.deleteMany({});
      }
    }
    
    const config = await db.kisConfig.create({
      data: {
        appKey: finalAppKey,
        appSecret: finalAppSecret,
        accountNo: finalAccountNo,
        isDemo: isDemo ?? existing?.isDemo ?? true,
      },
    });

    console.log(`[KIS Config] Saved config: id=${config.id}, isDemo=${config.isDemo}`);
    return NextResponse.json({ 
      success: true, 
      data: {
        id: config.id,
        appKey: config.appKey.substring(0, 8) + '****',
        accountNo: config.accountNo,
        isDemo: config.isDemo,
      }
    });
  } catch (error) {
    console.error('[KIS Config] POST error:', error);
    return NextResponse.json(
      { success: false, error: '설정 저장 실패', detail: String(error) },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    console.log('[KIS Config] DELETE request');
    await db.kisConfig.deleteMany({});
    console.log('[KIS Config] All configs deleted');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[KIS Config] DELETE error:', error);
    return NextResponse.json(
      { success: false, error: '설정 삭제 실패', detail: String(error) },
      { status: 500 }
    );
  }
}
