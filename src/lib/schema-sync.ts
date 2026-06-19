// 런타임 스키마 동기화 (Runtime Schema Sync)
// ─────────────────────────────────────────────────────────────
// Railway 재배포 시 자동으로 DB 스키마를 최신 상태로 동기화
// - prisma migrate deploy가 실행되지 않은 경우 폴백
// - start.sh에서 npx prisma migrate deploy가 실패해도
//   Next.js 서버가 뜨면서 한 번 더 동기화 시도
//
// 동기화 대상 (IF NOT EXISTS 안전 SQL):
//   1) TradeHistory v2 필드 (source, orderExecutionMode, currentPrice, orderPrice, filledPrice, avgFillPrice, slippagePercent, rtCd, msgCd, msg1)
//   2) Position v2 필드 (highSinceEntry, stopLossPrice, takeProfitPrice, trailingStopPrice, entryATR, partialExitCount, realizedPnL, source)
//
// 사용자 신고:
//   "Invalid `prisma.tradeHistory.create()` failed: column `source` does not exist"
//   → 본 모듈이 start.sh와 별개로 동작하여 보장

import { prisma, ensurePrismaConnected, isPrismaAvailable } from './prisma';

let _syncAttempted = false;
let _syncSuccess = false;
let _syncError: string | null = null;
let _syncedAt: string | null = null;
let _syncedColumns: string[] = [];

const TRADEHISTORY_V2_COLUMNS: Array<{ name: string; sql: string }> = [
  { name: 'source', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'AGENT';` },
  { name: 'orderExecutionMode', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderExecutionMode" TEXT NOT NULL DEFAULT 'DRY_RUN';` },
  { name: 'currentPrice', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "currentPrice" DOUBLE PRECISION;` },
  { name: 'orderPrice', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderPrice" DOUBLE PRECISION;` },
  { name: 'filledPrice', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "filledPrice" DOUBLE PRECISION;` },
  { name: 'avgFillPrice', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "avgFillPrice" DOUBLE PRECISION;` },
  { name: 'slippagePercent', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "slippagePercent" DOUBLE PRECISION;` },
  { name: 'rtCd', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "rtCd" TEXT;` },
  { name: 'msgCd', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msgCd" TEXT;` },
  { name: 'msg1', sql: `ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msg1" TEXT;` },
];

const POSITION_V2_COLUMNS: Array<{ name: string; sql: string }> = [
  { name: 'highSinceEntry', sql: `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "highSinceEntry" DOUBLE PRECISION;` },
  { name: 'stopLossPrice', sql: `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "stopLossPrice" DOUBLE PRECISION;` },
  { name: 'takeProfitPrice', sql: `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "takeProfitPrice" DOUBLE PRECISION;` },
  { name: 'trailingStopPrice', sql: `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "trailingStopPrice" DOUBLE PRECISION;` },
  { name: 'entryATR', sql: `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryATR" DOUBLE PRECISION;` },
  { name: 'partialExitCount', sql: `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "partialExitCount" INTEGER NOT NULL DEFAULT 0;` },
  { name: 'realizedPnL', sql: `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "realizedPnL" DOUBLE PRECISION;` },
  { name: 'source', sql: `ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'KIS_BALANCE';` },
];

/**
 * 런타임 스키마 동기화 (idempotent)
 *
 * - DATABASE_URL이 없으면 스킵
 * - 이미 시도한 경우 재시도 안 함 (프로세스 생명주기당 1회)
 * - 실패해도 예외 throw하지 않음 (서버 시작 차단 방지)
 *
 * @returns 동기화 성공 여부
 */
export async function ensureSchemaSynced(): Promise<{
  attempted: boolean;
  success: boolean;
  error: string | null;
  syncedAt: string | null;
  syncedColumns: string[];
}> {
  // 1) DATABASE_URL 없으면 스킵
  if (!isPrismaAvailable()) {
    return {
      attempted: false,
      success: false,
      error: 'DATABASE_URL not set',
      syncedAt: null,
      syncedColumns: [],
    };
  }

  // 2) 이미 시도한 경우 캐시 반환
  if (_syncAttempted) {
    return {
      attempted: true,
      success: _syncSuccess,
      error: _syncError,
      syncedAt: _syncedAt,
      syncedColumns: _syncedColumns,
    };
  }

  _syncAttempted = true;

  try {
    await ensurePrismaConnected();
    console.log('[SchemaSync] 런타임 스키마 동기화 시작');

    const syncedColumns: string[] = [];

    // TradeHistory v2 컬럼 동기화
    for (const col of TRADEHISTORY_V2_COLUMNS) {
      try {
        await prisma.$executeRawUnsafe(col.sql);
        syncedColumns.push(`TradeHistory.${col.name}`);
      } catch (e) {
        // 이미 존재하거나 다른 이유로 실패 — 다음 컬럼으로 계속
        console.warn(`[SchemaSync] TradeHistory.${col.name} 동기화 스킵:`, e instanceof Error ? e.message : 'Unknown');
      }
    }

    // Position v2 컬럼 동기화
    for (const col of POSITION_V2_COLUMNS) {
      try {
        await prisma.$executeRawUnsafe(col.sql);
        syncedColumns.push(`Position.${col.name}`);
      } catch (e) {
        console.warn(`[SchemaSync] Position.${col.name} 동기화 스킵:`, e instanceof Error ? e.message : 'Unknown');
      }
    }

    // Position.source 백필 — strategy=MANUAL이면 source=MANUAL로
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Position" SET "source" = 'MANUAL' WHERE "strategy" = 'MANUAL' AND "source" = 'KIS_BALANCE';`
      );
    } catch (e) {
      // 무시
    }

    // Position.highSinceEntry 백필 — NULL이면 avgPrice로
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Position" SET "highSinceEntry" = "avgPrice" WHERE "highSinceEntry" IS NULL;`
      );
    } catch (e) {
      // 무시
    }

    // 검증: 핵심 컬럼들이 실제로 존재하는지 확인
    let verifiedColumns: string[] = [];
    try {
      const thCheck = await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'TradeHistory'
           AND column_name IN ('source', 'orderExecutionMode', 'currentPrice', 'orderPrice', 'filledPrice', 'avgFillPrice', 'slippagePercent')
         ORDER BY column_name;`
      ) as any[];
      verifiedColumns.push(...(thCheck || []).map((r: any) => `TradeHistory.${r.column_name}`));

      const posCheck = await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'Position'
           AND column_name IN ('source', 'highSinceEntry', 'stopLossPrice', 'takeProfitPrice', 'trailingStopPrice', 'entryATR', 'partialExitCount', 'realizedPnL')
         ORDER BY column_name;`
      ) as any[];
      verifiedColumns.push(...(posCheck || []).map((r: any) => `Position.${r.column_name}`));
    } catch (verifyErr) {
      console.warn('[SchemaSync] 검증 쿼리 실패:', verifyErr instanceof Error ? verifyErr.message : 'Unknown');
    }

    _syncSuccess = true;
    _syncedAt = new Date().toISOString();
    _syncedColumns = verifiedColumns;
    console.log(`[SchemaSync] ✅ 동기화 완료 — ${verifiedColumns.length}개 컬럼 검증됨:`, verifiedColumns);

    return {
      attempted: true,
      success: true,
      error: null,
      syncedAt: _syncedAt,
      syncedColumns: verifiedColumns,
    };
  } catch (e) {
    _syncError = e instanceof Error ? e.message : String(e);
    _syncSuccess = false;
    console.error('[SchemaSync] ❌ 동기화 실패:', _syncError);
    return {
      attempted: true,
      success: false,
      error: _syncError,
      syncedAt: null,
      syncedColumns: [],
    };
  }
}

/**
 * 스키마 동기화 상태 조회 (진단용)
 */
export function getSchemaSyncStatus() {
  return {
    attempted: _syncAttempted,
    success: _syncSuccess,
    error: _syncError,
    syncedAt: _syncedAt,
    syncedColumns: _syncedColumns,
  };
}
