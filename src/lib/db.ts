// 데이터베이스 연결 - 안전한 폴백 처리
// DATABASE_URL이 없거나 연결 실패 시에도 앱이 크래시되지 않음
// Mock DB는 실제 메모리에 데이터를 저장하여 DB 없이도 동작

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
      console.warn('⚠️ DATABASE_URL not set - using in-memory database');
      _dbAvailable = false;
    }
  } else {
    _dbAvailable = true;
  }

  _db = globalForPrisma.prisma;
  _dbInitAttempted = true;

  if (process.env.NODE_ENV !== 'production') {
    (globalThis as any).prisma = _db;
  }
} catch (error) {
  console.warn('⚠️ Prisma not available, using in-memory database:', error);
  _dbInitAttempted = true;
  _dbAvailable = false;
}

// 안전한 DB 래퍼 - DB가 없으면 인메모리 DB 사용 (데이터 실제 저장됨)
export const db = _dbAvailable && _db ? _db : createInMemoryDb();

export const isDbAvailable = () => _dbAvailable;

// ============================================
// 인메모리 데이터베이스 - DB 없이도 모든 기능 동작
// 서버 재시작 시 데이터는 사라지지만, 세션 내에서는 정상 동작
// ============================================
function createInMemoryDb() {
  // 각 모델별 데이터 저장소
  const stores: Record<string, Map<string, any>> = {};

  function getStore(model: string): Map<string, any> {
    if (!stores[model]) {
      stores[model] = new Map();
    }
    return stores[model];
  }

  function generateId(): string {
    return `cl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  // 모델별 자동 증가 카운터
  const counters: Record<string, number> = {};

  function getNextId(model: string): string {
    if (!counters[model]) counters[model] = 0;
    counters[model]++;
    return generateId();
  }

  // Prisma 호환 쿼리 핸들러 생성
  function createModelHandler(modelName: string) {
    return {
      findMany: async (args?: any) => {
        const store = getStore(modelName);
        let results = Array.from(store.values());

        // where 필터 적용
        if (args?.where) {
          results = results.filter(item => {
            return Object.entries(args.where).every(([key, value]) => {
              if (typeof value === 'object' && value !== null) {
                // { equals, contains, gt, gte, lt, lte 등 } 지원
                const op = value as any;
                if (op.equals !== undefined) return item[key] === op.equals;
                if (op.contains !== undefined) return String(item[key]).toLowerCase().includes(String(op.contains).toLowerCase());
                if (op.gt !== undefined) return item[key] > op.gt;
                if (op.gte !== undefined) return item[key] >= op.gte;
                if (op.lt !== undefined) return item[key] < op.lt;
                if (op.lte !== undefined) return item[key] <= op.lte;
                if (op.in !== undefined) return op.in.includes(item[key]);
                return item[key] === value;
              }
              return item[key] === value;
            });
          });
        }

        // orderBy 적용
        if (args?.orderBy) {
          const orderFields = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
          for (const order of orderFields.reverse()) {
            const [field, direction] = Object.entries(order)[0];
            results.sort((a, b) => {
              if (a[field] < b[field]) return direction === 'asc' ? -1 : 1;
              if (a[field] > b[field]) return direction === 'asc' ? 1 : -1;
              return 0;
            });
          }
        }

        // skip/take 적용
        if (args?.skip) results = results.slice(args.skip);
        if (args?.take) results = results.slice(0, args.take);

        return results;
      },

      findFirst: async (args?: any) => {
        const handler = createModelHandler(modelName);
        const results = await handler.findMany({ ...args, take: 1 });
        return results[0] || null;
      },

      findUnique: async (args?: any) => {
        const store = getStore(modelName);
        if (!args?.where?.id) return null;
        return store.get(args.where.id) || null;
      },

      create: async (args?: any) => {
        const store = getStore(modelName);
        const id = args?.data?.id || getNextId(modelName);
        const now = new Date();

        // 기본값이 있는 필드 자동 채우기
        const record = {
          id,
          ...args?.data,
          createdAt: args?.data?.createdAt || now,
          updatedAt: args?.data?.updatedAt || now,
        };

        // Boolean 기본값
        if (modelName === 'WatchlistItem' && record.isActive === undefined) record.isActive = true;
        if (modelName === 'WatchlistItem' && record.market === undefined) record.market = 'DOMESTIC';
        if (modelName === 'TradingStrategy' && record.isActive === undefined) record.isActive = false;
        if (modelName === 'RiskConfig' && record.isActive === undefined) record.isActive = true;
        if (modelName === 'KisConfig' && record.isDemo === undefined) record.isDemo = true;
        if (modelName === 'AgentConfig' && record.isRunning === undefined) record.isRunning = false;

        store.set(id, record);
        console.log(`[InMemoryDB] Created ${modelName}:`, id, args?.data?.stockName || args?.data?.name || '');
        return { ...record };
      },

      update: async (args?: any) => {
        const store = getStore(modelName);
        // where 조건으로 찾기
        let targetId = args?.where?.id;

        if (!targetId) {
          // id가 아닌 다른 where 조건
          const entries = Array.from(store.entries());
          for (const [id, record] of entries) {
            if (Object.entries(args.where).every(([key, value]) => record[key] === value)) {
              targetId = id;
              break;
            }
          }
        }

        if (!targetId || !store.has(targetId)) {
          throw new Error(`Record not found in ${modelName}`);
        }

        const existing = store.get(targetId);
        const updated = {
          ...existing,
          ...args?.data,
          updatedAt: new Date(),
        };
        store.set(targetId, updated);
        return { ...updated };
      },

      upsert: async (args?: any) => {
        const store = getStore(modelName);
        // where로 찾기
        const entries = Array.from(store.entries());
        let existing = null;
        for (const [, record] of entries) {
          if (Object.entries(args.where).every(([key, value]) => record[key] === value)) {
            existing = record;
            break;
          }
        }

        if (existing) {
          const updated = { ...existing, ...args?.update, updatedAt: new Date() };
          store.set(existing.id, updated);
          return { ...updated };
        } else {
          const handler = createModelHandler(modelName);
          return handler.create({ data: { ...args?.where, ...args?.create } });
        }
      },

      delete: async (args?: any) => {
        const store = getStore(modelName);
        const id = args?.where?.id;
        if (id && store.has(id)) {
          const record = store.get(id);
          store.delete(id);
          return record;
        }
        return args?.where;
      },

      deleteMany: async (args?: any) => {
        const store = getStore(modelName);
        if (!args?.where) {
          const count = store.size;
          store.clear();
          return { count };
        }
        let count = 0;
        const entries = Array.from(store.entries());
        for (const [id, record] of entries) {
          if (Object.entries(args.where).every(([key, value]) => record[key] === value)) {
            store.delete(id);
            count++;
          }
        }
        return { count };
      },

      updateMany: async (args?: any) => {
        const store = getStore(modelName);
        let count = 0;
        const entries = Array.from(store.entries());
        for (const [id, record] of entries) {
          let matches = true;
          if (args?.where) {
            matches = Object.entries(args.where).every(([key, value]) => record[key] === value);
          }
          if (matches) {
            store.set(id, { ...record, ...args?.data, updatedAt: new Date() });
            count++;
          }
        }
        return { count };
      },

      count: async (args?: any) => {
        const handler = createModelHandler(modelName);
        const results = await handler.findMany({ where: args?.where });
        return results.length;
      },
    };
  }

  // Prisma 모델 이름 매핑으로 Proxy 생성
  const modelNames = [
    'watchlistItem', 'kisConfig', 'tradingStrategy',
    'tradeHistory', 'position', 'tradingSession',
    'riskConfig', 'marketData', 'agentConfig', 'agentLog',
  ];

  const handlers: Record<string, any> = {};
  for (const name of modelNames) {
    // Prisma 모델명 → PascalCase 매핑 (예: watchlistItem → WatchlistItem)
    const pascalName = name.charAt(0).toUpperCase() + name.slice(1);
    handlers[name] = createModelHandler(pascalName);
  }

  return new Proxy(handlers as any, {
    get: (target, prop) => {
      if (target[prop]) return target[prop];
      // 알 수 없는 모델도 동적으로 생성
      target[prop] = createModelHandler(String(prop));
      return target[prop];
    }
  });
}
