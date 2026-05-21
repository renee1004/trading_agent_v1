#!/bin/bash
# Railway 시작 스크립트
# 1. Prisma 마이그레이션 실행 (실패해도 계속)
# 2. Next.js 서버 시작

echo "🚀 Starting AI Trading Agent..."

# Prisma 마이그레이션 시도 (DB가 준비되지 않았어도 서버는 시작)
if [ -n "$DATABASE_URL" ]; then
  echo "🔄 Running database migrations..."
  npx prisma migrate deploy || echo "⚠️ Migration failed, will retry on next deploy"
  npx prisma generate || echo "⚠️ Prisma generate failed"
else
  echo "⚠️ No DATABASE_URL set, skipping migrations"
  npx prisma generate || echo "⚠️ Prisma generate failed"
fi

echo "✅ Starting Next.js server on port ${PORT:-3000}..."
exec node server.js
