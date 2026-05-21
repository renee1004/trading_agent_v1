#!/bin/bash
# Railway 시작 스크립트
# 1. Prisma 마이그레이션 실행
# 2. Next.js 서버 시작

set -e

echo "🔄 Running database migrations..."
npx prisma migrate deploy

echo "🚀 Starting AI Trading Agent..."
exec node server.js
