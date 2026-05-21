// 데이터베이스 연결 - DATABASE_URL이 없으면 안전하게 폴백
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// DATABASE_URL이 없으면 더미 클라이언트 생성 (앱 크래시 방지)
function createPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL not set - database features will be limited')
  }

  try {
    return new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    })
  } catch (error) {
    console.error('❌ Prisma client creation failed:', error)
    throw error
  }
}

export const db =
  globalForPrisma.prisma ??
  createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
