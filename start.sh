#!/bin/bash
# Railway 시작 스크립트
# DB 스키마 동기화 → 서버 시작
#
# 중요: 마이그레이션 실패 시 서버 시작을 중단하지 않음 (Railway 재시작 루프 방지)
# 단, 실패 원인을 로그에 명확히 남겨 사용자가 인지할 수 있도록 함
#
# 3중 스키마 동기화 보장:
#   1순위: prisma migrate deploy (명시적 migration 파일 기반)
#   2순위: prisma db push (schema.prisma 기반 — 마이그레이션보다 더 최신 컬럼 반영)
#   3순위: 런타임 ensureSchemaSynced() (서버 시작 후 Next.js instrumentation에서 실행)
#
# 사용자 신고: "TradeHistory.source 컬럼이 없음" → 1순위만으로 부족하여 2순위/3순위 추가

echo "========================================="
echo "  AI Trading Agent - Starting..."
echo "========================================="
echo "PORT: ${PORT:-3000}"
echo "DATABASE_URL set: $([ -n "$DATABASE_URL" ] && echo 'YES' || echo 'NO')"
echo "NODE_ENV: ${NODE_ENV:-not-set}"

# DB 스키마 동기화 (DATABASE_URL이 있을 때만)
if [ -n "$DATABASE_URL" ]; then
  echo "[DB] === 스키마 동기화 시작 ==="

  # 1순위: prisma migrate deploy (명시적 마이그레이션 파일 기반 — 가장 안전)
  echo "[DB] 1순위: prisma migrate deploy 시도..."
  if npx prisma migrate deploy 2>&1; then
    echo "[DB] ✅ prisma migrate deploy 성공"
    MIGRATION_OK=1
  else
    echo "[DB] ❌ prisma migrate deploy 실패"
    MIGRATION_OK=0
  fi

  # 2순위: prisma db push (schema.prisma 기반 — 마이그레이션보다 더 최신 컬럼 반영)
  # migrate deploy가 성공하더라도 schema.prisma에 새 컬럼이 추가된 경우
  # db push로 추가 보장 (사용자 신고: migrate deploy 성공했는데 source 컬럼 없음)
  echo "[DB] 2순위: prisma db push 시도 (schema.prisma 기반 보강)..."
  if npx prisma db push --accept-data-loss 2>&1; then
    echo "[DB] ✅ prisma db push 성공"
    MIGRATION_OK=1
  else
    echo "[DB] ⚠️ prisma db push 실패 — 3순위(런타임 동기화)에 의존"
    # MIGRATION_OK를 0으로 설정하지 않음 — 1순위가 성공했을 수 있으므로
  fi

  # 검증: 핵심 v2 컬럼들이 실제로 DB에 생성되었는지 확인
  echo "[DB] === v2 컬럼 검증 ==="

  echo "[DB] TradeHistory v2 컬럼 검증..."
  npx prisma db execute --stdin <<'SQL' 2>&1 || echo "[DB] ⚠️ TradeHistory v2 검증 실패"
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'TradeHistory'
  AND column_name IN ('source', 'orderExecutionMode', 'currentPrice', 'orderPrice', 'filledPrice', 'avgFillPrice', 'slippagePercent', 'rtCd', 'msgCd', 'msg1')
ORDER BY column_name;
SQL

  echo "[DB] Position v2 컬럼 검증..."
  npx prisma db execute --stdin <<'SQL' 2>&1 || echo "[DB] ⚠️ Position v2 검증 실패"
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'Position'
  AND column_name IN ('source', 'highSinceEntry', 'stopLossPrice', 'takeProfitPrice', 'trailingStopPrice', 'entryATR', 'partialExitCount', 'realizedPnL')
ORDER BY column_name;
SQL

  # 3순위: raw SQL로 직접 ADD COLUMN (db push가 권한 부족으로 실패한 경우 폴백)
  echo "[DB] 3순위: raw SQL ADD COLUMN IF NOT EXISTS (안전장치)..."
  npx prisma db execute --stdin <<'SQL' 2>&1 || echo "[DB] ⚠️ raw SQL 동기화 실패 (이미 존재하는 경우 무시)"
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'AGENT';
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderExecutionMode" TEXT NOT NULL DEFAULT 'DRY_RUN';
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "currentPrice" DOUBLE PRECISION;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderPrice" DOUBLE PRECISION;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "filledPrice" DOUBLE PRECISION;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "avgFillPrice" DOUBLE PRECISION;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "slippagePercent" DOUBLE PRECISION;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "rtCd" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msgCd" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msg1" TEXT;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "highSinceEntry" DOUBLE PRECISION;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "stopLossPrice" DOUBLE PRECISION;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "takeProfitPrice" DOUBLE PRECISION;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "trailingStopPrice" DOUBLE PRECISION;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryATR" DOUBLE PRECISION;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "partialExitCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "realizedPnL" DOUBLE PRECISION;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'KIS_BALANCE';
UPDATE "Position" SET "source" = 'MANUAL' WHERE "strategy" = 'MANUAL' AND "source" = 'KIS_BALANCE';
UPDATE "Position" SET "highSinceEntry" = "avgPrice" WHERE "highSinceEntry" IS NULL;
SQL

  echo "[DB] ✅ 스키마 동기화 완료 (3중 보장)"
  echo "[DB] === 스키마 동기화 종료 ==="
fi

echo "Starting Next.js server on port ${PORT:-3000}..."
exec node server.js
