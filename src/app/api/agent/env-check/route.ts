// 환경변수 및 DB 상태 진단 API
// Railway 배포 시 KIS 설정, DATABASE_URL, DB 연결 상태를 한번에 확인

import { NextResponse } from 'next/server';
import { db, isDbAvailable, getDbType } from '@/lib/db';

export async function GET() {
  try {
    // 1. 환경변수 상태 (값은 마스킹하여 노출하지 않음)
    const envStatus = {
      DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'NOT_SET',
      // DATABASE_URL 형식 확인 (postgresql:// vs file: vs 기타)
      DATABASE_URL_FORMAT: process.env.DATABASE_URL
        ? (process.env.DATABASE_URL.startsWith('postgresql://') ? 'postgresql://'
          : process.env.DATABASE_URL.startsWith('postgres://') ? 'postgres://'
          : process.env.DATABASE_URL.startsWith('file:') ? 'file: (SQLite)'
          : 'other')
        : 'N/A',
      KIS_APP_KEY: process.env.KIS_APP_KEY ? 'SET' : 'NOT_SET',
      KIS_APP_SECRET: process.env.KIS_APP_SECRET ? 'SET' : 'NOT_SET',
      KIS_ACCOUNT_NO: process.env.KIS_ACCOUNT_NO ? 'SET' : 'NOT_SET',
      KIS_IS_DEMO: process.env.KIS_IS_DEMO || 'NOT_SET',
      ALLOW_AFTER_HOURS_TRADING: process.env.ALLOW_AFTER_HOURS_TRADING || 'NOT_SET',
      NODE_ENV: process.env.NODE_ENV || 'NOT_SET',
    };

    // 2. DB 연결 상태
    const dbType = getDbType();
    const dbAvailable = isDbAvailable();

    // 3. Prisma 연결 진단 (DATABASE_URL이 있는데 InMemory인 원인 파악)
    let prismaDiagnosis: Record<string, unknown> = {};
    if (process.env.DATABASE_URL && dbType === 'InMemory') {
      // DATABASE_URL은 있는데 InMemory → Prisma 연결 실패한 상황
      try {
        const { PrismaClient } = require('@prisma/client');
        prismaDiagnosis.clientImport = 'OK';

        const testClient = new PrismaClient({ log: ['error'] });
        try {
          await testClient.$connect();
          prismaDiagnosis.connect = 'OK';

          // 스키마/마이그레이션 테이블 확인
          try {
            const migrationResult = await testClient.$queryRaw`SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_name = '_prisma_migrations'` as any[];
            const migrationExists = Number(migrationResult?.[0]?.cnt) > 0;
            prismaDiagnosis.migrationTable = migrationExists ? 'EXISTS' : 'NOT_FOUND';

            if (migrationExists) {
              const watchlistResult = await testClient.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name` as any[];
              prismaDiagnosis.tables = watchlistResult?.map((r: any) => r.table_name) || [];
            }
          } catch (schemaError) {
            prismaDiagnosis.schemaCheck = `FAILED: ${schemaError instanceof Error ? schemaError.message : String(schemaError)}`;
          }
        } catch (connectError) {
          prismaDiagnosis.connect = `FAILED: ${connectError instanceof Error ? connectError.message : String(connectError)}`;
        }
        await testClient.$disconnect().catch(() => {});
      } catch (importError) {
        prismaDiagnosis.clientImport = `FAILED: ${importError instanceof Error ? importError.message : String(importError)}`;
      }
    }

    // 3. KIS 설정 (DB)
    let kisConfigStatus: Record<string, unknown> = { exists: false };
    try {
      const config = await db.kisConfig.findFirst();
      if (config) {
        kisConfigStatus = {
          exists: true,
          appKeyPrefix: (config as any).appKey?.substring(0, 8) + '****',
          accountNo: (config as any).accountNo || '',
          isDemo: (config as any).isDemo,
          hasAccessToken: !!(config as any).accessToken,
          tokenExpiresAt: (config as any).tokenExpiresAt?.toISOString() || null,
        };
      }
    } catch (e) {
      kisConfigStatus = { exists: false, error: String(e) };
    }

    // 4. AgentConfig 상태
    let agentConfigStatus: Record<string, unknown> = { exists: false };
    try {
      const agentConfig = await db.agentConfig.findFirst();
      if (agentConfig) {
        agentConfigStatus = {
          exists: true,
          isRunning: (agentConfig as any).isRunning,
          schedulerMode: (agentConfig as any).schedulerMode,
          totalCycles: (agentConfig as any).totalCycles,
          totalTrades: (agentConfig as any).totalTrades,
        };
      }
    } catch (e) {
      agentConfigStatus = { exists: false, error: String(e) };
    }

    // 5. 포지션/거래내역 수
    let positionCount = 0;
    let tradeCount = 0;
    try {
      const positions = await db.position.findMany();
      positionCount = positions.length;
      const trades = await db.tradeHistory.findMany({ take: 1 });
      tradeCount = trades.length;
    } catch (e) {}

    // 6. 최신 커밋 정보 (빌드 시 주입 가능)
    const commitInfo = {
      COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA?.substring(0, 7) || 'NOT_SET',
      COMMIT_BRANCH: process.env.RAILWAY_GIT_BRANCH || 'NOT_SET',
      RAILWAY_SERVICE_ID: process.env.RAILWAY_SERVICE_ID ? 'SET' : 'NOT_SET',
    };

    // 종합 판정
    let diagnosis = 'UNKNOWN';
    const issues: string[] = [];

    if (!process.env.DATABASE_URL) {
      issues.push('DATABASE_URL 미설정 → 인메모리 DB 사용 (재시작 시 데이터 손실)');
    } else if (dbType === 'InMemory') {
      issues.push('DATABASE_URL 있음에도 인메모리 DB 사용 → Prisma 연결/마이그레이션 실패 추정');
    }
    if (envStatus.KIS_APP_KEY === 'NOT_SET' && !kisConfigStatus.exists) {
      issues.push('KIS 설정 없음 (환경변수 + DB 모두 비어있음) → 캔들 조회 불가');
    }
    if (dbType === 'InMemory') {
      issues.push('인메모리 DB 사용 중 → 서버 재시작 시 모든 설정/로그 손실');
    }

    if (issues.length === 0) {
      diagnosis = 'ALL_OK';
    } else {
      diagnosis = 'ISSUES_FOUND';
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      diagnosis,
      issues,
      env: envStatus,
      database: {
        type: dbType,
        available: dbAvailable,
      },
      prismaDiagnosis,
      kisConfig: kisConfigStatus,
      agentConfig: agentConfigStatus,
      dataCounts: {
        positions: positionCount,
        recentTrades: tradeCount,
      },
      railway: commitInfo,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
