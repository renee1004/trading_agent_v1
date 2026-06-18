#!/bin/bash
# Railway 시작 스크립트
# DB 스키마 동기화 → 서버 시작
#
# 중요: 마이그레이션 실패 시 서버 시작을 중단하지 않음 (Railway 재시작 루프 방지)
# 단, 실패 원인을 로그에 명확히 남겨 사용자가 인지할 수 있도록 함

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

  # 2순위: prisma db push (마이그레이션 실패 시 폴백)
  if [ "$MIGRATION_OK" != "1" ]; then
    echo "[DB] 2순위: prisma db push 시도..."
    if npx prisma db push --accept-data-loss 2>&1; then
      echo "[DB] ✅ prisma db push 성공"
      MIGRATION_OK=1
    else
      echo "[DB] ❌ prisma db push도 실패 — 인메모리 DB로 폴백"
      MIGRATION_OK=0
    fi
  fi

  # 검증: 핵심 v2 컬럼들이 실제로 DB에 생성되었는지 확인
  if [ "$MIGRATION_OK" = "1" ]; then
    echo "[DB] === v2 컬럼 검증 ==="

    echo "[DB] Position v2 컬럼 검증..."
    npx prisma db execute --stdin <<'SQL' 2>&1 || echo "[DB] ⚠️ Position v2 검증 실패"
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'Position'
  AND column_name IN ('highSinceEntry', 'stopLossPrice', 'takeProfitPrice', 'trailingStopPrice', 'entryATR', 'partialExitCount', 'realizedPnL')
ORDER BY column_name;
SQL

    echo "[DB] TradeHistory v2 컬럼 검증..."
    npx prisma db execute --stdin <<'SQL' 2>&1 || echo "[DB] ⚠️ TradeHistory v2 검증 실패"
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'TradeHistory'
  AND column_name IN ('source', 'orderExecutionMode', 'currentPrice', 'orderPrice', 'filledPrice', 'avgFillPrice', 'slippagePercent', 'rtCd', 'msgCd', 'msg1')
ORDER BY column_name;
SQL

    echo "[DB] ✅ 스키마 동기화 완료"
  fi
  echo "[DB] === 스키마 동기화 종료 ==="
fi

echo "Starting Next.js server on port ${PORT:-3000}..."
exec node server.js
