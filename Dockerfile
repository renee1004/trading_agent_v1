# Railway 배포용 Dockerfile
# Next.js + Prisma + PostgreSQL

FROM node:20-slim AS base

# OpenSSL 필요 (Prisma용)
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 종속성 설치 단계
FROM base AS deps
COPY package.json bun.lock* package-lock.json* yarn.lock* ./
RUN \
  if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
  elif [ -f package-lock.json ]; then npm ci; \
  elif [ -f bun.lock ]; then npm ci; \
  else npm i; \
  fi

# 빌드 단계
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma 클라이언트 생성
RUN npx prisma generate

# Next.js 빌드
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# 실행 단계
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Prisma 스키마와 마이그레이션 파일 복사
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# 시작 스크립트
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["./start.sh"]
