// KIS API 설정 관리 라우트
// DB + 환경변수 fallback 지원

import { NextRequest, NextResponse } from 'next/server';
import { db, getDbType } from '@/lib/db';
import { getOrCreateKisConfigFromEnv, normalizeKisAccountNo } from '@/lib/kis-config-loader';

export async function GET() {
  try {
    console.log(`[KIS Config] GET request, DB type: ${getDbType()}`);

    // 공통 로더 사용: DB + env fallback
    const envConfig = await getOrCreateKisConfigFromEnv();

    // DB에서 직접 조회 (공통 로더가 자동 저장했을 수 있음)
    const configs = await db.kisConfig.findMany();

    if (configs.length > 0) {
      // appSecret 마스킹 처리
      const masked = configs.map((c: any) => ({
        id: c.id,
        appKey: c.appKey ? c.appKey.substring(0, 4) + '****' : '',
        accountNo: c.accountNo || '',
        isDemo: c.isDemo ?? true,
        tokenExpiresAt: c.tokenExpiresAt || null,
        accessToken: c.accessToken ? 'exists' : '',
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));

      console.log(`[KIS Config] Found ${configs.length} config(s) in DB`);
      return NextResponse.json({ success: true, data: masked });
    }

    // DB에 없지만 env에서 로드된 경우 (DB 저장 실패 시나리오)
    if (envConfig) {
      const maskedEnv = [{
        id: 'env-loaded',
        appKey: envConfig.appKey.substring(0, 4) + '****',
        accountNo: envConfig.accountNo,
        isDemo: envConfig.isDemo,
        tokenExpiresAt: null,
        accessToken: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      }];

      console.log('[KIS Config] Config loaded from env (DB save may have failed)');
      return NextResponse.json({ success: true, data: maskedEnv });
    }

    // DB도 env도 없음
    console.log('[KIS Config] No config found in DB or env');
    return NextResponse.json({ success: true, data: [] });
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
    const rawAccountNo = accountNo || existing?.accountNo;

    if (!finalAppKey || !finalAppSecret || !rawAccountNo) {
      return NextResponse.json(
        { success: false, error: '필수 항목 누락 (App Key, App Secret, 계좌번호)' },
        { status: 400 }
      );
    }

    // 계좌번호 정규화 (8자리 → 10자리, 하이픈 제거)
    let finalAccountNo: string;
    try {
      finalAccountNo = normalizeKisAccountNo(rawAccountNo);
    } catch (e) {
      return NextResponse.json(
        { success: false, error: e instanceof Error ? e.message : '계좌번호 형식 오류' },
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

    console.log(`[KIS Config] Saved config: id=${config.id}, accountNo=${config.accountNo}, isDemo=${config.isDemo}`);
    return NextResponse.json({
      success: true,
      data: {
        id: config.id,
        appKey: config.appKey.substring(0, 4) + '****',
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
