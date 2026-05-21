// 데이터베이스 연결 - 안전한 폴백 처리
// DATABASE_URL이 없거나 연결 실패 시에도 앱이 크래시되지 않음
// 인메모리 DB는 실제 메모리에 데이터를 저장하여 DB 없이도 동작

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

// 안전한 DB 래퍼
export const db = _dbAvailable && _db ? _db : createInMemoryDb();

export const isDbAvailable = () => _dbAvailable;

// ============================================
// 인메모리 데이터베이스 - DB 없이도 모든 기능 동작
// 각 모델별로 독립적인 Map 사용, 재귀 호출 없이 단순 구현
// ============================================
function createInMemoryDb() {
  // 각 모델별 독립적인 데이터 저장소
  const stores: Record<string, Map<string, any>> = {};

  function getStore(model: string): Map<string, any> {
    if (!stores[model]) {
      stores[model] = new Map();
    }
    return stores[model];
  }

  function genId(): string {
    return `cl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  // where 조건으로 레코드 필터링
  function matchesWhere(record: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        const op = value as any;
        if (op.equals !== undefined) return record[key] === op.equals;
        if (op.contains !== undefined) return String(record[key] || '').toLowerCase().includes(String(op.contains).toLowerCase());
        if (op.gt !== undefined) return record[key] > op.gt;
        if (op.gte !== undefined) return record[key] >= op.gte;
        if (op.lt !== undefined) return record[key] < op.lt;
        if (op.lte !== undefined) return record[key] <= op.lte;
        if (op.in !== undefined) return Array.isArray(op.in) && op.in.includes(record[key]);
      }
      return record[key] === value;
    });
  }

  // 기본값 설정
  function applyDefaults(modelName: string, record: any): void {
    if (record.isActive === undefined && ['WatchlistItem', 'RiskConfig'].includes(modelName)) record.isActive = true;
    if (record.isActive === undefined && modelName === 'TradingStrategy') record.isActive = false;
    if (record.market === undefined && modelName === 'WatchlistItem') record.market = 'DOMESTIC';
    if (record.isDemo === undefined && modelName === 'KisConfig') record.isDemo = true;
    if (record.isRunning === undefined && modelName === 'AgentConfig') record.isRunning = false;
  }

  // 정렬 적용
  function applyOrderBy(results: any[], orderBy: any): any[] {
    if (!orderBy) return results;
    const orderFields = Array.isArray(orderBy) ? orderBy : [orderBy];
    for (const order of orderFields) {
      const [field, direction] = Object.entries(order)[0];
      results.sort((a, b) => {
        const aVal = a[field] ?? '';
        const bVal = b[field] ?? '';
        if (aVal < bVal) return direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return results;
  }

  // 모델 핸들러 생성 (재귀 호출 없이 독립 함수만 사용)
  function createHandler(modelName: string) {
    return {
      findMany: async (args?: any) => {
        const store = getStore(modelName);
        let results = Array.from(store.values());
        if (args?.where) results = results.filter(r => matchesWhere(r, args.where));
        if (args?.orderBy) results = applyOrderBy(results, args.orderBy);
        if (args?.skip) results = results.slice(args.skip);
        if (args?.take) results = results.slice(0, args.take);
        return results;
      },

      findFirst: async (args?: any) => {
        const store = getStore(modelName);
        let results = Array.from(store.values());
        if (args?.where) results = results.filter(r => matchesWhere(r, args.where));
        if (args?.orderBy) results = applyOrderBy(results, args.orderBy);
        return results[0] || null;
      },

      findUnique: async (args?: any) => {
        const store = getStore(modelName);
        if (!args?.where?.id) return null;
        return store.get(args.where.id) || null;
      },

      create: async (args?: any) => {
        const store = getStore(modelName);
        const id = args?.data?.id || genId();
        const now = new Date();
        const record = {
          id,
          ...args?.data,
          createdAt: args?.data?.createdAt || now,
          updatedAt: args?.data?.updatedAt || now,
        };
        applyDefaults(modelName, record);
        store.set(id, record);
        console.log(`[InMemoryDB] Created ${modelName}:`, id, args?.data?.stockName || args?.data?.name || '');
        return { ...record };
      },

      update: async (args?: any) => {
        const store = getStore(modelName);
        let targetId = args?.where?.id;
        if (!targetId) {
          // where 조건으로 찾기
          for (const [id, record] of store.entries()) {
            if (matchesWhere(record, args?.where)) {
              targetId = id;
              break;
            }
          }
        }
        if (!targetId || !store.has(targetId)) {
          throw new Error(`Record not found in ${modelName}`);
        }
        const existing = store.get(targetId);
        const updated = { ...existing, ...args?.data, updatedAt: new Date() };
        store.set(targetId, updated);
        return { ...updated };
      },

      upsert: async (args?: any) => {
        const store = getStore(modelName);
        for (const [, record] of store.entries()) {
          if (matchesWhere(record, args?.where)) {
            const updated = { ...record, ...args?.update, updatedAt: new Date() };
            store.set(record.id, updated);
            return { ...updated };
          }
        }
        // 없으면 create
        const id = args?.create?.id || args?.where?.id || genId();
        const now = new Date();
        const record = { id, ...args?.where, ...args?.create, createdAt: now, updatedAt: now };
        applyDefaults(modelName, record);
        store.set(id, record);
        return { ...record };
      },

      delete: async (args?: any) => {
        const store = getStore(modelName);
        const id = args?.where?.id;
        if (id && store.has(id)) {
          const record = store.get(id);
          store.delete(id);
          return record;
        }
        // where 조건으로 찾아서 삭제
        for (const [rid, record] of store.entries()) {
          if (matchesWhere(record, args?.where)) {
            store.delete(rid);
            return record;
          }
        }
        return null;
      },

      deleteMany: async (args?: any) => {
        const store = getStore(modelName);
        if (!args?.where) {
          const count = store.size;
          store.clear();
          return { count };
        }
        let count = 0;
        for (const [id, record] of Array.from(store.entries())) {
          if (matchesWhere(record, args.where)) {
            store.delete(id);
            count++;
          }
        }
        return { count };
      },

      updateMany: async (args?: any) => {
        const store = getStore(modelName);
        let count = 0;
        for (const [id, record] of store.entries()) {
          if (!args?.where || matchesWhere(record, args.where)) {
            store.set(id, { ...record, ...args?.data, updatedAt: new Date() });
            count++;
          }
        }
        return { count };
      },

      count: async (args?: any) => {
        const store = getStore(modelName);
        if (!args?.where) return store.size;
        return Array.from(store.values()).filter(r => matchesWhere(r, args.where)).length;
      },
    };
  }

  // Prisma 모델 이름 매핑
  const modelNames = [
    'watchlistItem', 'kisConfig', 'tradingStrategy',
    'tradeHistory', 'position', 'tradingSession',
    'riskConfig', 'marketData', 'agentConfig', 'agentLog',
  ];

  const handlers: Record<string, any> = {};
  for (const name of modelNames) {
    const pascalName = name.charAt(0).toUpperCase() + name.slice(1);
    handlers[name] = createHandler(pascalName);
  }

  return new Proxy(handlers as any, {
    get: (target, prop) => {
      if (target[prop]) return target[prop];
      // 알 수 없는 모델도 동적으로 생성
      const pascalName = String(prop).charAt(0).toUpperCase() + String(prop).slice(1);
      target[prop] = createHandler(pascalName);
      return target[prop];
    }
  });
}
