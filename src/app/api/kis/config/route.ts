// KIS API 설정 관리 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  try {
    const configs = await db.kisConfig.findMany({
      select: {
        id: true,
        appKey: true,
        appSecret: false,
        accountNo: true,
        isDemo: true,
        tokenExpiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    
    const masked = configs.map(c => ({
      ...c,
      appKey: c.appKey.substring(0, 8) + '****',
    }));

    return NextResponse.json({ success: true, data: masked });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '설정 조회 실패' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { appKey, appSecret, accountNo, isDemo } = body;

    if (!appKey || !appSecret || !accountNo) {
      return NextResponse.json(
        { success: false, error: '필수 항목 누락' },
        { status: 400 }
      );
    }

    await db.kisConfig.deleteMany({});
    
    const config = await db.kisConfig.create({
      data: {
        appKey,
        appSecret,
        accountNo,
        isDemo: isDemo ?? true,
      },
    });

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
    return NextResponse.json(
      { success: false, error: '설정 저장 실패' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    await db.kisConfig.deleteMany({});
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '설정 삭제 실패' },
      { status: 500 }
    );
  }
}
