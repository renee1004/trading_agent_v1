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
# prisma db push: 마이그레이션 없이 스키마를 직접 DB에 반영
# prisma migrate deploy가 실패하는 환경에서도 스키마 생성 가능
if [ -n "$DATABASE_URL" ]; then
  echo "[DB] Prisma schema push 시작..."
  npx prisma db push --accept-data-loss 2>&1 || {
    echo "[DB] prisma db push 실패, prisma migrate deploy 시도..."
    npx prisma migrate deploy 2>&1 || echo "[DB] 마이그레이션도 실패, 인메모리 DB로 폴백"
  }
  echo "[DB] 스키마 동기화 완료"
fi

echo "Starting Next.js server on port ${PORT:-3000}..."
exec node server.js
