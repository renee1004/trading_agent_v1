// 데이터베이스 연결 - 안전한 폴백 처리
// DATABASE_URL이 없거나 연결 실패 시에도 앱이 크래시되지 않음

let _db: any = null;
let _dbInitAttempted = false;
let _dbAvailable = false;

try {
  const { PrismaClient } = require('@prisma/client');

  const globalForPrisma = globalThis as unknown as {
    prisma: any | undefined
  }

  if (!globalForPrisma.prisma) {
    if (process.env.DATABASE_URL) {
      try {
        globalForPrisma.prisma = new PrismaClient({
          log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
        });
        _dbAvailable = true;
        console.log('✅ Database connected successfully');
      } catch (error) {
        console.warn('⚠️ Prisma client creation failed, using fallback:', error);
        _dbAvailable = false;
      }
    } else {
      console.warn('⚠️ DATABASE_URL not set - database features will use mock data');
      _dbAvailable = false;
    }
  }

  _db = globalForPrisma.prisma;
  _dbInitAttempted = true;

  if (process.env.NODE_ENV !== 'production') {
    (globalThis as any).prisma = _db;
  }
} catch (error) {
  console.warn('⚠️ Prisma not available, using mock database:', error);
  _dbInitAttempted = true;
  _dbAvailable = false;
}

// 안전한 DB 래퍼 - DB가 없으면 빈 결과 반환
export const db = _dbAvailable && _db ? _db : createMockDb();

function createMockDb() {
  const emptyHandler = {
    findMany: () => Promise.resolve([]),
    findFirst: () => Promise.resolve(null),
    findUnique: () => Promise.resolve(null),
    create: (args: any) => {
      console.log('[MockDB] create:', args?.data);
      return Promise.resolve({ id: `mock-${Date.now()}`, ...args?.data });
    },
    update: (args: any) => {
      console.log('[MockDB] update:', args?.where, args?.data);
      return Promise.resolve({ ...args?.where, ...args?.data });
    },
    delete: (args: any) => {
      console.log('[MockDB] delete:', args?.where);
      return Promise.resolve(args?.where);
    },
    deleteMany: () => Promise.resolve({ count: 0 }),
    updateMany: () => Promise.resolve({ count: 0 }),
    upsert: (args: any) => {
      console.log('[MockDB] upsert:', args?.where);
      return Promise.resolve({ id: `mock-${Date.now()}`, ...args?.create, ...args?.update });
    },
  };

  // 모든 Prisma 모델에 대해 빈 핸들러 반환
  return new Proxy({} as any, {
    get: (target, prop) => {
      if (!target[prop]) {
        target[prop] = emptyHandler;
      }
      return target[prop];
    }
  });
}

export const isDbAvailable = () => _dbAvailable;
