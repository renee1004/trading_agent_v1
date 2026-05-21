# Railway 배포용 Dockerfile - Next.js Standalone
# PORT: Railway가 자동 할당, 앱은 process.env.PORT 사용

FROM node:20-slim AS base

# OpenSSL 필요 (Prisma용)
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ===== 종속성 설치 단계 =====
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ===== 빌드 단계 =====
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma 클라이언트 생성
RUN npx prisma generate

# Next.js 빌드 (standalone 모드)
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# .env 파일 제거 (로컬 설정이 Railway 환경변수를 방해하지 않도록)
RUN rm -f .next/standalone/.env

# ===== 실행 단계 =====
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Railway가 PORT를 자동 할당하므로 기본값만 설정
# (Railway 환경변수가 Docker ENV보다 우선)
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# standalone 빌드 결과물 복사
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma 스키마/마이그레이션/엔진 복사
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Prisma CLI도 복사 (마이그레이션 실행용)
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# 시작 스크립트
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

USER nextjs

EXPOSE 3000

CMD ["./start.sh"]
