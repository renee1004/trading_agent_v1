// GET /api/system/schema-sync
// 런타임 스키마 동기화 상태 조회 + 수동 재동기화 트리거
//
// 응답 (GET):
//   {
//     success: true,
//     attempted: boolean,
//     success: boolean,
//     error: string | null,
//     syncedAt: string | null,
//     syncedColumns: string[],
//     expectedColumns: { tradehistory: [...], position: [...] },
//     actualColumns: { tradehistory: [...], position: [...] },
//     missingColumns: string[],
//     healthy: boolean,
//     hint: string,
//   }
//
// POST: 수동으로 스키마 재동기화 강제 실행
//   body: { force: true } → 캐시 무시하고 raw SQL 재실행

import { NextRequest, NextResponse } from 'next/server';
import { ensureSchemaSynced, getSchemaSyncStatus } from '@/lib/schema-sync';
import { prisma, ensurePrismaConnected, isPrismaAvailable } from '@/lib/prisma';

const EXPECTED_TRADEHISTORY_COLUMNS = [
  'source', 'orderExecutionMode', 'currentPrice', 'orderPrice',
  'filledPrice', 'avgFillPrice', 'slippagePercent', 'rtCd', 'msgCd', 'msg1',
];

const EXPECTED_POSITION_COLUMNS = [
  'source', 'highSinceEntry', 'stopLossPrice', 'takeProfitPrice',
  'trailingStopPrice', 'entryATR', 'partialExitCount', 'realizedPnL',
];

async function checkActualColumns(): Promise<{ tradehistory: string[]; position: string[]; missing: string[] }> {
  if (!isPrismaAvailable()) {
    return { tradehistory: [], position: [], missing: ['DATABASE_URL not set'] };
  }
  try {
    await ensurePrismaConnected();
    const thRows = await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'TradeHistory'
         AND column_name IN ('source', 'orderExecutionMode', 'currentPrice', 'orderPrice',
                             'filledPrice', 'avgFillPrice', 'slippagePercent', 'rtCd', 'msgCd', 'msg1')
       ORDER BY column_name;`
    ) as any[];
    const posRows = await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'Position'
         AND column_name IN ('source', 'highSinceEntry', 'stopLossPrice', 'takeProfitPrice',
                             'trailingStopPrice', 'entryATR', 'partialExitCount', 'realizedPnL')
       ORDER BY column_name;`
    ) as any[];

    const thCols = (thRows || []).map((r: any) => `TradeHistory.${r.column_name}`);
    const posCols = (posRows || []).map((r: any) => `Position.${r.column_name}`);
    const allExpected = [
      ...EXPECTED_TRADEHISTORY_COLUMNS.map(c => `TradeHistory.${c}`),
      ...EXPECTED_POSITION_COLUMNS.map(c => `Position.${c}`),
    ];
    const found = new Set([...thCols, ...posCols]);
    const missing = allExpected.filter(c => !found.has(c));

    return { tradehistory: thCols, position: posCols, missing };
  } catch (e) {
    return {
      tradehistory: [],
      position: [],
      missing: [`검증 쿼리 실패: ${e instanceof Error ? e.message : 'Unknown'}`],
    };
  }
}

export async function GET() {
  const status = getSchemaSyncStatus();
  const actual = await checkActualColumns();

  return NextResponse.json({
    // success: status.success 우선 — 단 status.attempted=false인 경우 (아직 동기화 시도 전) actual.healthy로 판단
    success: status.attempted ? status.success : actual.missing.length === 0,
    attempted: status.attempted,
    syncSuccess: status.success,
    error: status.error,
    syncedAt: status.syncedAt,
    syncedColumns: status.syncedColumns,
    expectedColumns: {
      tradehistory: EXPECTED_TRADEHISTORY_COLUMNS,
      position: EXPECTED_POSITION_COLUMNS,
    },
    actualColumns: {
      tradehistory: actual.tradehistory,
      position: actual.position,
    },
    missingColumns: actual.missing,
    healthy: actual.missing.length === 0,
    hint: actual.missing.length > 0
      ? '스키마 동기화 누락 — POST /api/system/schema-sync {force:true} 로 수동 재시도, 또는 Railway 서버 재배포'
      : '정상 — 모든 v2 컬럼이 DB에 존재함',
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const force = body?.force === true;

    if (force) {
      if (!isPrismaAvailable()) {
        return NextResponse.json({
          success: false,
          error: 'DATABASE_URL not set',
        }, { status: 503 });
      }
      try {
        await ensurePrismaConnected();
        const syncSqls = [
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'AGENT';`,
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderExecutionMode" TEXT NOT NULL DEFAULT 'DRY_RUN';`,
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "currentPrice" DOUBLE PRECISION;`,
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderPrice" DOUBLE PRECISION;`,
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "filledPrice" DOUBLE PRECISION;`,
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "avgFillPrice" DOUBLE PRECISION;`,
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "slippagePercent" DOUBLE PRECISION;`,
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "rtCd" TEXT;`,
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msgCd" TEXT;`,
          `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msg1" TEXT;`,
          `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "highSinceEntry" DOUBLE PRECISION;`,
          `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "stopLossPrice" DOUBLE PRECISION;`,
          `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "takeProfitPrice" DOUBLE PRECISION;`,
          `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "trailingStopPrice" DOUBLE PRECISION;`,
          `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryATR" DOUBLE PRECISION;`,
          `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "partialExitCount" INTEGER NOT NULL DEFAULT 0;`,
          `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "realizedPnL" DOUBLE PRECISION;`,
          `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'KIS_BALANCE';`,
          `UPDATE "Position" SET "source" = 'MANUAL' WHERE "strategy" = 'MANUAL' AND "source" = 'KIS_BALANCE';`,
          `UPDATE "Position" SET "highSinceEntry" = "avgPrice" WHERE "highSinceEntry" IS NULL;`,
        ];
        const results: Array<{ sql: string; ok: boolean; error?: string }> = [];
        for (const sql of syncSqls) {
          try {
            await prisma.$executeRawUnsafe(sql);
            results.push({ sql: sql.split('\n')[0].substring(0, 100), ok: true });
          } catch (e) {
            results.push({
              sql: sql.split('\n')[0].substring(0, 100),
              ok: false,
              error: e instanceof Error ? e.message : 'Unknown',
            });
          }
        }
        const actual = await checkActualColumns();
        return NextResponse.json({
          success: true,
          force: true,
          results,
          actualColumns: {
            tradehistory: actual.tradehistory,
            position: actual.position,
          },
          missingColumns: actual.missing,
          healthy: actual.missing.length === 0,
        });
      } catch (e) {
        return NextResponse.json({
          success: false,
          error: e instanceof Error ? e.message : 'Unknown',
        }, { status: 500 });
      }
    }

    // force=false: ensureSchemaSynced() 호출 (캐시된 경우 그대로 반환)
    const result = await ensureSchemaSynced();
    const actual = await checkActualColumns();
    return NextResponse.json({
      success: result.success,
      attempted: result.attempted,
      syncSuccess: result.success,
      error: result.error,
      syncedAt: result.syncedAt,
      syncedColumns: result.syncedColumns,
      actualColumns: {
        tradehistory: actual.tradehistory,
        position: actual.position,
      },
      missingColumns: actual.missing,
      healthy: actual.missing.length === 0,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown',
    }, { status: 500 });
  }
}
