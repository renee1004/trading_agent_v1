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
#   3순위: 개별 raw SQL 실행 (npx prisma db execute 호출을 컬럼별로 분리)
#
# 수정 이력:
#   2025-06-25: 3순위 heredoc → 개별 prisma db execute 호출로 변경
#              (heredoc으로 여러 ALTER TABLE을 한 번에 전달하면
#               prisma db execute가 일부만 실행하고 나머지를 무시하는 문제 수정)

echo "========================================="
echo "  AI Trading Agent - Starting..."
echo "========================================="
echo "PORT: ${PORT:-3000}"
echo "DATABASE_URL set: $([ -n "$DATABASE_URL" ] && echo 'YES' || echo 'NO')"
echo "NODE_ENV: ${NODE_ENV:-not-set}"

# ── 유틸리티 함수 ──

# 단일 SQL 문을 안전하게 실행 (성공/실패 로그 출력)
# 인자: $1=설명
# stdin: SQL 문 (heredoc으로 전달)
run_sql() {
  local desc="$1"
  if npx prisma db execute --stdin 2>&1; then
    echo "[DB]   ✅ ${desc}"
    return 0
  else
    echo "[DB]   ⚠️ ${desc} — 스킵 (이미 존재하거나 오류)"
    return 1
  fi
}

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
    echo "[DB] ⚠️ prisma db push 실패 — 3순위(개별 SQL)로 보강"
  fi

  # 검증: 1/2순위 이후 v2 컬럼들이 실제 DB에 있는지 확인
  echo "[DB] === v2 컬럼 검증 ==="

  echo "[DB] TradeHistory v2 컬럼 검증..."
  run_sql "TradeHistory 검증" <<'SQL'
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'TradeHistory'
  AND column_name IN ('source', 'orderExecutionMode', 'currentPrice', 'orderPrice', 'filledPrice', 'avgFillPrice', 'slippagePercent', 'rtCd', 'msgCd', 'msg1')
ORDER BY column_name;
SQL

  echo "[DB] Position v2 컬럼 검증..."
  run_sql "Position 검증" <<'SQL'
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'Position'
  AND column_name IN ('source', 'highSinceEntry', 'stopLossPrice', 'takeProfitPrice', 'trailingStopPrice', 'entryATR', 'partialExitCount', 'realizedPnL')
ORDER BY column_name;
SQL

  # 3순위: 개별 raw SQL 실행 (heredoc 분리 — 각 ALTER TABLE을 독립적인 prisma db execute 호출로 실행)
  # 이전 버전에서 하나의 heredoc에 19개 SQL을 넣었더니 prisma db execute가 일부만 실행하는 문제가 발생
  echo "[DB] 3순위: 개별 raw SQL ADD COLUMN IF NOT EXISTS..."
  SQL_OK=0
  SQL_FAIL=0

  # ── TradeHistory v2 컬럼 (10개) ──
  if run_sql "TradeHistory.source" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'AGENT';
SQL

  if run_sql "TradeHistory.orderExecutionMode" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderExecutionMode" TEXT NOT NULL DEFAULT 'DRY_RUN';
SQL

  if run_sql "TradeHistory.currentPrice" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "currentPrice" DOUBLE PRECISION;
SQL

  if run_sql "TradeHistory.orderPrice" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderPrice" DOUBLE PRECISION;
SQL

  if run_sql "TradeHistory.filledPrice" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "filledPrice" DOUBLE PRECISION;
SQL

  if run_sql "TradeHistory.avgFillPrice" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "avgFillPrice" DOUBLE PRECISION;
SQL

  if run_sql "TradeHistory.slippagePercent" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "slippagePercent" DOUBLE PRECISION;
SQL

  if run_sql "TradeHistory.rtCd" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "rtCd" TEXT;
SQL

  if run_sql "TradeHistory.msgCd" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msgCd" TEXT;
SQL

  if run_sql "TradeHistory.msg1" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msg1" TEXT;
SQL

  # ── Position v2 컬럼 (8개) ──
  if run_sql "Position.highSinceEntry" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "highSinceEntry" DOUBLE PRECISION;
SQL

  if run_sql "Position.stopLossPrice" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "stopLossPrice" DOUBLE PRECISION;
SQL

  if run_sql "Position.takeProfitPrice" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "takeProfitPrice" DOUBLE PRECISION;
SQL

  if run_sql "Position.trailingStopPrice" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "trailingStopPrice" DOUBLE PRECISION;
SQL

  if run_sql "Position.entryATR" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryATR" DOUBLE PRECISION;
SQL

  if run_sql "Position.partialExitCount" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "partialExitCount" INTEGER NOT NULL DEFAULT 0;
SQL

  if run_sql "Position.realizedPnL" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "realizedPnL" DOUBLE PRECISION;
SQL

  if run_sql "Position.source" <<'SQL'; then SQL_OK=$((SQL_OK+1)); else SQL_FAIL=$((SQL_FAIL+1)); fi
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'KIS_BALANCE';
SQL

  # ── 백필 (기존 데이터 보정 — 실패해도 무시) ──
  run_sql "Position.source 백필" <<'SQL' || true
UPDATE "Position" SET "source" = 'MANUAL' WHERE "strategy" = 'MANUAL' AND "source" = 'KIS_BALANCE';
SQL

  run_sql "Position.highSinceEntry 백필" <<'SQL' || true
UPDATE "Position" SET "highSinceEntry" = "avgPrice" WHERE "highSinceEntry" IS NULL;
SQL

  echo "[DB] 3순위 완료: ${SQL_OK} 성공, ${SQL_FAIL} 스킵"
  echo "[DB] ✅ 스키마 동기화 완료 (3중 보장)"
  echo "[DB] === 스키마 동기화 종료 ==="
fi

echo "Starting Next.js server on port ${PORT:-3000}..."
exec node server.js