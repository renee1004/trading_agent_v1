#!/bin/bash
# Railway 시작 스크립트

echo "🚀 Starting AI Trading Agent..."
echo "DATABASE_URL set: $([ -n "$DATABASE_URL" ] && echo 'YES' || echo 'NO')"
echo "PORT: ${PORT:-3000}"

# Prisma generate (반드시 필요)
npx prisma generate 2>&1 || echo "⚠️ Prisma generate had warnings"

# DB 마이그레이션 (DATABASE_URL이 있을 때만, 실패해도 계속)
if [ -n "$DATABASE_URL" ]; then
  echo "🔄 Running database migrations..."
  npx prisma migrate deploy 2>&1 || echo "⚠️ Migration had issues, app will start with fallback mode"
fi

echo "✅ Starting Next.js server on port ${PORT:-3000}..."
exec node server.js
