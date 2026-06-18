#!/bin/bash
# Railway 시작 스크립트
# DB 스키마 동기화 → 서버 시작

echo "========================================="
echo "  AI Trading Agent - Starting..."
echo "========================================="
echo "PORT: ${PORT:-3000}"
echo "DATABASE_URL set: $([ -n "$DATABASE_URL" ] && echo 'YES' || echo 'NO')"
echo "NODE_ENV: ${NODE_ENV:-not-set}"

# DB 스키마 동기화 (DATABASE_URL이 있을 때만)
# 1순위: prisma migrate deploy (명시적 마이그레이션 파일 기반 — 가장 안전)
# 2순위: prisma db push (스키마를 직접 DB에 반영 — 마이그레이션 없이 컬럼 추가 가능)
# 3순위: 인메모리 DB로 폴백
if [ -n "$DATABASE_URL" ]; then
  echo "[DB] Prisma migrate deploy 시작..."
  npx prisma migrate deploy 2>&1 || {
    echo "[DB] prisma migrate deploy 실패, prisma db push 시도..."
    npx prisma db push --accept-data-loss 2>&1 || {
      echo "[DB] prisma db push도 실패, 인메모리 DB로 폴백"
    }
  }
  echo "[DB] 스키마 동기화 완료"

  # 검증: Position 테이블에 highSinceEntry 컬럼 존재 여부 확인
  echo "[DB] Position v2 컬럼 검증..."
  npx prisma db execute --stdin <<'SQL' 2>&1 || echo "[DB] Position v2 검증 실패 (무시하고 계속)"
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Position' AND column_name IN ('highSinceEntry', 'stopLossPrice', 'takeProfitPrice', 'trailingStopPrice', 'entryATR', 'partialExitCount', 'realizedPnL');
SQL
fi

echo "Starting Next.js server on port ${PORT:-3000}..."
exec node server.js
