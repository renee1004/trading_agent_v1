// PrismaClient 싱글톤 — db.ts Proxy를 우회하는 직접 Prisma 연결
// Railway(Production)에서 DATABASE_URL이 설정된 경우에만 사용
// 이 모듈은 db.ts의 비동기 초기화 경쟁상태를 완전히 회피합니다.

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'error', 'warn']
      : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Prisma 연결 상태 확인
 * 연결이 안 되어 있으면 false 반환
 */
let _connected = false;

export async function ensurePrismaConnected(): Promise<boolean> {
  if (_connected) return true;
  try {
    await prisma.$connect();
    _connected = true;
    return true;
  } catch (e) {
    console.error('[Prisma] 연결 실패:', e instanceof Error ? e.message : 'Unknown');
    return false;
  }
}

/**
 * Prisma 사용 가능 여부 (DATABASE_URL 설정 여부)
 */
export function isPrismaAvailable(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * AppSetting 읽기 — findFirst 사용 (findUnique 불필요)
 * key에 unique 제약조건이 없어도 동작
 */
export async function getAppSetting(key: string): Promise<{ value: unknown } | null> {
  try {
    await ensurePrismaConnected();
    const record = await prisma.appSetting.findFirst({
      where: { key },
    });
    return record;
  } catch (e) {
    console.error(`[Prisma] getAppSetting(${key}) 실패:`, e instanceof Error ? e.message : 'Unknown');
    return null;
  }
}

/**
 * AppSetting 저장 — findFirst → update/create (upsert 우회)
 * upsert의 where { key } unique 제약조건 의존성을 회피
 */
export async function setAppSetting(key: string, value: Record<string, unknown>): Promise<boolean> {
  try {
    await ensurePrismaConnected();

    // 1) 기존 레코드 찾기
    const existing = await prisma.appSetting.findFirst({
      where: { key },
    });

    if (existing) {
      // 2a) 업데이트
      await prisma.appSetting.update({
        where: { id: existing.id },
        data: { value },
      });
    } else {
      // 2b) 새로 생성
      await prisma.appSetting.create({
        data: { key, value },
      });
    }

    // 3) 읽기 검증
    const saved = await prisma.appSetting.findFirst({
      where: { key },
    });

    if (!saved || !saved.value || typeof saved.value !== 'object') {
      console.error(`[Prisma] setAppSetting 검증 실패: key=${key}, saved=${JSON.stringify(saved)}`);
      return false;
    }

    return true;
  } catch (e) {
    console.error(`[Prisma] setAppSetting(${key}) 실패:`, e instanceof Error ? e.message : 'Unknown');

    // Raw SQL 폴백
    try {
      const jsonStr = JSON.stringify(value);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "AppSetting" ("id", "key", "value", "createdAt", "updatedAt")
         VALUES ($1, $2, $3::jsonb, NOW(), NOW())
         ON CONFLICT ("key") DO UPDATE SET "value" = $3::jsonb, "updatedAt" = NOW()`,
        `sett_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        key,
        jsonStr
      );
      console.log(`[Prisma] setAppSetting Raw SQL 폴백 성공: key=${key}`);
      return true;
    } catch (rawError) {
      console.error(`[Prisma] setAppSetting Raw SQL도 실패:`, rawError instanceof Error ? rawError.message : 'Unknown');
      return false;
    }
  }
}

/**
 * AppSetting 전체 목록 조회 (진단용)
 */
export async function getAllAppSettings(): Promise<Array<{ key: string; value: unknown }>> {
  try {
    await ensurePrismaConnected();
    return await prisma.appSetting.findMany({
      select: { key: true, value: true },
    });
  } catch (e) {
    console.error('[Prisma] getAllAppSettings 실패:', e instanceof Error ? e.message : 'Unknown');
    return [];
  }
}
