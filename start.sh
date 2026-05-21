#!/bin/bash
# Railway 시작 스크립트
# 1. Prisma 마이그레이션 실행 (실패해도 계속)
# 2. Next.js 서버 시작

echo "🚀 Starting AI Trading Agent..."
echo "DATABASE_URL set: $([ -n "$DATABASE_URL" ] && echo 'YES' || echo 'NO')"
echo "PORT: ${PORT:-3000}"

# Prisma 준비
npx prisma generate 2>/dev/null || echo "⚠️ Prisma generate skipped"

# DB 마이그레이션 (DATABASE_URL이 있을 때만)
if [ -n "$DATABASE_URL" ]; then
  echo "🔄 Running database migrations..."
  npx prisma migrate deploy 2>/dev/null || echo "⚠️ Migration failed, app will start anyway"
else
  echo "⚠️ No DATABASE_URL - skipping migrations, using mock data"
fi

echo "✅ Starting Next.js server on port ${PORT:-3000}..."
exec node server.js
