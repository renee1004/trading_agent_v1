// 데이터베이스 연결 - 안전한 폴백 처리
// DATABASE_URL이 없거나 연결 실패 시에도 앱이 크래시되지 않음
// 인메모리 DB는 실제 메모리에 데이터를 저장하여 DB 없이도 동작

import { NextResponse } from 'next/server';

// ============================================
// 인메모리 데이터베이스 - DB 없이도 모든 기능 동작
// Prisma와 완벽 호환되는 API 제공
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

  // select 필드 선택 적용
  function applySelect(record: any, select: any): any {
    if (!select || typeof select !== 'object') return record;
    const result: any = {};
    for (const [key, value] of Object.entries(select)) {
      if (value === true && key in record) {
        result[key] = record[key];
      }
      // value가 false면 제외
    }
    return result;
  }

  // 모델 핸들러 생성
  function createHandler(modelName: string) {
    return {
      findMany: async (args?: any) => {
        const store = getStore(modelName);
        let results = Array.from(store.values());
        if (args?.where) results = results.filter(r => matchesWhere(r, args.where));
        if (args?.orderBy) results = applyOrderBy(results, args.orderBy);
        if (args?.skip) results = results.slice(args.skip);
        if (args?.take) results = results.slice(0, args.take);
        if (args?.select) results = results.map(r => applySelect(r, args.select));
        return results;
      },

      findFirst: async (args?: any) => {
        const store = getStore(modelName);
        let results = Array.from(store.values());
        if (args?.where) results = results.filter(r => matchesWhere(r, args.where));
        if (args?.orderBy) results = applyOrderBy(results, args.orderBy);
        const result = results[0] || null;
        if (result && args?.select) return applySelect(result, args.select);
        return result;
      },

      findUnique: async (args?: any) => {
        const store = getStore(modelName);
        // 1순위: where.id로 직접 조회 (빠른 경로)
        if (args?.where?.id) {
          const result = store.get(args.where.id) || null;
          if (result && args?.select) return applySelect(result, args.select);
          return result;
        }
        // 2순위: where에 다른 unique 필드가 있으면 순차 검색
        // (AppSetting.key 등 @unique 필드 지원)
        if (args?.where && Object.keys(args.where).length > 0) {
          for (const [, record] of store.entries()) {
            if (matchesWhere(record, args.where)) {
              if (args?.select) return applySelect(record, args.select);
              return { ...record };
            }
          }
        }
        return null;
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
    'appSetting',
  ];

  const handlers: Record<string, any> = {};
  for (const name of modelNames) {
    const pascalName = name.charAt(0).toUpperCase() + name.slice(1);
    handlers[name] = createHandler(pascalName);
  }

  // ── Raw SQL 호환 레이어 ──
  // $queryRaw / $executeRaw 호출 시 InMemory DB에서도 동작하도록 구현
  // Prisma의 $queryRaw는 SQL을 직접 실행하지만, InMemory에서는
  // SQL 문자열을 파싱하여 대응하는 store 작업을 수행
  const rawSqlHandler = {
    $queryRaw: async (sqlTemplate: any, ...values: any[]) => {
      // Tagged template literal: $queryRaw`SELECT ...` 형태
      // sqlTemplate.strings와 values로 SQL 재구성
      const sql = typeof sqlTemplate === 'string'
        ? sqlTemplate
        : Array.isArray(sqlTemplate?.strings)
          ? sqlTemplate.strings.reduce((acc: string, str: string, i: number) => acc + str + (i < values.length ? String(values[i]) : ''), '')
          : String(sqlTemplate);

      // AppSetting 테이블 SELECT 쿼리 감지
      if (/SELECT.*FROM.*"AppSetting"/i.test(sql)) {
        const keyMatch = sql.match(/WHERE\s+"key"\s*=\s*['"]?(\$\d+|[^'"\s)]+)/i);
        // 값이 $1 형태의 파라미터인 경우 values 배열에서 찾기
        let searchKey: string | null = null;
        if (keyMatch) {
          const paramRef = keyMatch[1];
          if (paramRef.startsWith('$')) {
            const paramIdx = parseInt(paramRef.slice(1)) - 1;
            searchKey = values[paramIdx] ?? null;
          } else {
            searchKey = paramRef;
          }
        }

        const store = getStore('AppSetting');
        if (searchKey) {
          for (const [, record] of store.entries()) {
            if (record.key === searchKey) {
              return [{ key: record.key, value: record.value }];
            }
          }
        }
        return [];
      }

      // 다른 SELECT 쿼리 - 빈 결과 반환
      console.warn('[InMemoryDB] $queryRaw: 지원하지 않는 SQL (빈 결과 반환):', sql.substring(0, 100));
      return [];
    },

    $executeRaw: async (sqlTemplate: any, ...values: any[]) => {
      const sql = typeof sqlTemplate === 'string'
        ? sqlTemplate
        : Array.isArray(sqlTemplate?.strings)
          ? sqlTemplate.strings.reduce((acc: string, str: string, i: number) => acc + str + (i < values.length ? String(values[i]) : ''), '')
          : String(sqlTemplate);

      // AppSetting INSERT/UPDATE 감지
      if (/INSERT\s+INTO\s+"AppSetting"/i.test(sql) || /UPDATE\s+"AppSetting"/i.test(sql)) {
        // SQL에서 key와 value 추출 시도
        // Prisma tagged template의 경우 values 배열에 순서대로 파라미터가 들어있음
        // INSERT: VALUES (${crypto.randomUUID()}, ${SETTINGS_DB_KEY}, ${jsonStr}::jsonb, NOW(), NOW())
        // values = [uuid, key, jsonStr]
        const store = getStore('AppSetting');

        if (/INSERT\s+INTO/i.test(sql) && values.length >= 3) {
          const id = String(values[0]);
          const key = String(values[1]);
          let value = values[2];
          // JSON 문자열이면 파싱
          if (typeof value === 'string') {
            try { value = JSON.parse(value); } catch { /* 객체 그대로 사용 */ }
          }

          // ON CONFLICT 처리 (upsert)
          let existingId: string | null = null;
          for (const [rid, record] of store.entries()) {
            if (record.key === key) {
              existingId = rid;
              break;
            }
          }

          if (existingId) {
            // UPDATE
            const existing = store.get(existingId);
            store.set(existingId, { ...existing, value, updatedAt: new Date() });
          } else {
            // INSERT
            store.set(id, { id, key, value, createdAt: new Date(), updatedAt: new Date() });
          }
          return 1; // 영향받은 행 수
        }

        if (/UPDATE\s+"AppSetting"/i.test(sql) && values.length >= 2) {
          // UPDATE "AppSetting" SET "value" = ${jsonStr}::jsonb WHERE "key" = ${SETTINGS_DB_KEY}
          // values 순서: jsonStr, key (또는 그 반대 - SQL 구조에 따라 다름)
          let jsonValue = values[0];
          let keyValue = values[1];
          // JSON 문자열이면 파싱
          if (typeof jsonValue === 'string') {
            try { jsonValue = JSON.parse(jsonValue); } catch { /* 그대로 */ }
          }

          for (const [rid, record] of store.entries()) {
            if (record.key === keyValue) {
              store.set(rid, { ...record, value: jsonValue, updatedAt: new Date() });
              return 1;
            }
          }
          // key가 파라미터 반대 순서일 수도 있음
          if (typeof values[1] === 'string') {
            try { jsonValue = JSON.parse(values[1]); } catch { /* 그대로 */ }
          }
          for (const [rid, record] of store.entries()) {
            if (record.key === values[0]) {
              store.set(rid, { ...record, value: jsonValue, updatedAt: new Date() });
              return 1;
            }
          }
          return 0;
        }
      }

      // 지원하지 않는 SQL - 경고만 로그
      console.warn('[InMemoryDB] $executeRaw: 지원하지 않는 SQL (무시):', sql.substring(0, 100));
      return 0;
    },

    $executeRawUnsafe: async (sql: string, ...values: any[]) => {
      console.warn('[InMemoryDB] $executeRawUnsafe: 무시:', sql.substring(0, 100));
      return 0;
    },

    $queryRawUnsafe: async (sql: string, ...values: any[]) => {
      console.warn('[InMemoryDB] $queryRawUnsafe: 빈 결과 반환:', sql.substring(0, 100));
      return [];
    },
  };

  return new Proxy(handlers as any, {
    get: (target, prop) => {
      // $로 시작하는 Prisma 내장 메서드
      if (typeof prop === 'string' && prop.startsWith('$')) {
        return (rawSqlHandler as any)[prop];
      }
      if (target[prop]) return target[prop];
      // 알 수 없는 모델도 동적으로 생성
      const pascalName = String(prop).charAt(0).toUpperCase() + String(prop).slice(1);
      target[prop] = createHandler(pascalName);
      return target[prop];
    }
  });
}

// ============================================
// DB 초기화 - Prisma 연결 시도 후 실패 시 인메모리 폴백
// ============================================

let _prismaClient: any = null;
let _inMemoryDb: any = null;
let _usePrisma = false;

async function initPrisma(): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    console.warn('[DB] DATABASE_URL not set - using in-memory database');
    return false;
  }

  try {
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });

    // 실제 연결 테스트 - $connect()로 DB에 접근 가능한지 확인
    await client.$connect();
    
    // 마이그레이션 테이블 존재 확인 - 스키마가 적용되었는지 검증
    // prisma migrate deploy: _prisma_migrations 테이블 생성
    // prisma db push: 데이터 테이블만 생성 (_prisma_migrations 없음)
    // 따라서 두 가지 경우 모두 처리해야 함
    try {
      // 먼저 실제 데이터 테이블이 있는지 확인 (db push로 생성된 경우)
      const watchlistCheck = await client.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name` as any[];
      const tableNames = watchlistCheck?.map((r: any) => r.table_name) || [];
      const hasDataTables = tableNames.some((t: string) =>
        ['KisConfig', 'kisconfig', 'AgentConfig', 'agentconfig', 'WatchlistItem', 'watchlistitem'].includes(t)
      );

      if (hasDataTables) {
        console.log('[DB] Prisma connected and data tables found - using PostgreSQL');
        console.log('[DB] Tables:', tableNames.join(', '));
        _prismaClient = client;
        return true;
      }

      // 데이터 테이블이 없으면 마이그레이션 테이블 확인
      const migrationResult = await client.$queryRaw`SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_name = '_prisma_migrations'` as any[];
      const migrationExists = Number(migrationResult?.[0]?.cnt) > 0;

      if (migrationExists) {
        console.log('[DB] Prisma connected with migrations - using PostgreSQL');
        _prismaClient = client;
        return true;
      }

      console.warn('[DB] Database connected but no data tables found');
      console.warn('[DB] Available tables:', tableNames.join(', ') || '(none)');

      // 테이블이 없으면 raw SQL로 직접 생성 (prisma db push가 동작하지 않는 환경 대비)
      console.log('[DB] Creating tables via raw SQL...');
      try {
        // 각 테이블을 개별적으로 생성 (다중 문장 실행 지원 안 함)
        // gen_random_uuid() 대신 Prisma가 앱 레벨에서 cuid() 생성
        const createStatements = [
          `CREATE TABLE IF NOT EXISTS "KisConfig" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "appKey" TEXT NOT NULL, "appSecret" TEXT NOT NULL, "accountNo" TEXT NOT NULL,
            "isDemo" BOOLEAN NOT NULL DEFAULT true, "accessToken" TEXT, "tokenExpiresAt" TIMESTAMP(3),
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS "AgentConfig" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "isRunning" BOOLEAN NOT NULL DEFAULT false, "currentSessionId" TEXT, "schedulerMode" TEXT NOT NULL DEFAULT 'SERVER',
            "cycleIntervalMs" INTEGER NOT NULL DEFAULT 60000, "tradeOnlyMarketHours" BOOLEAN NOT NULL DEFAULT true,
            "domesticMarketOpen" TEXT NOT NULL DEFAULT '08:30', "domesticMarketClose" TEXT NOT NULL DEFAULT '18:00',
            "overseasMarketOpen" TEXT NOT NULL DEFAULT '23:30', "overseasMarketClose" TEXT NOT NULL DEFAULT '06:00',
            "totalCycles" INTEGER NOT NULL DEFAULT 0, "totalTrades" INTEGER NOT NULL DEFAULT 0,
            "dailyPnL" DOUBLE PRECISION NOT NULL DEFAULT 0, "lastCycleAt" TIMESTAMP(3), "lastCycleResult" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS "TradeHistory" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "stockCode" TEXT NOT NULL, "stockName" TEXT NOT NULL, "tradeType" TEXT NOT NULL,
            "quantity" INTEGER NOT NULL, "price" DOUBLE PRECISION NOT NULL, "totalAmount" DOUBLE PRECISION NOT NULL,
            "strategy" TEXT, "profitLoss" DOUBLE PRECISION, "profitRate" DOUBLE PRECISION,
            "status" TEXT NOT NULL DEFAULT 'PENDING', "orderNo" TEXT, "signalReason" TEXT,
            "market" TEXT NOT NULL DEFAULT 'DOMESTIC', "exchangeCode" TEXT, "currency" TEXT NOT NULL DEFAULT 'KRW',
            "source" TEXT NOT NULL DEFAULT 'AGENT', "orderExecutionMode" TEXT NOT NULL DEFAULT 'DRY_RUN',
            "currentPrice" DOUBLE PRECISION, "orderPrice" DOUBLE PRECISION,
            "filledPrice" DOUBLE PRECISION, "avgFillPrice" DOUBLE PRECISION, "slippagePercent" DOUBLE PRECISION,
            "rtCd" TEXT, "msgCd" TEXT, "msg1" TEXT,
            "tradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS "Position" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "stockCode" TEXT NOT NULL, "stockName" TEXT NOT NULL, "quantity" INTEGER NOT NULL,
            "avgPrice" DOUBLE PRECISION NOT NULL, "currentPrice" DOUBLE PRECISION, "profitLoss" DOUBLE PRECISION, "profitRate" DOUBLE PRECISION,
            "strategy" TEXT, "market" TEXT NOT NULL DEFAULT 'DOMESTIC', "exchangeCode" TEXT, "currency" TEXT NOT NULL DEFAULT 'KRW',
            "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS "TradingSession" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "status" TEXT NOT NULL DEFAULT 'STOPPED', "strategyId" TEXT,
            "startedAt" TIMESTAMP(3), "stoppedAt" TIMESTAMP(3),
            "totalProfit" DOUBLE PRECISION NOT NULL DEFAULT 0, "totalTrades" INTEGER NOT NULL DEFAULT 0,
            "winTrades" INTEGER NOT NULL DEFAULT 0, "lossTrades" INTEGER NOT NULL DEFAULT 0, "maxDrawdown" DOUBLE PRECISION NOT NULL DEFAULT 0,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS "WatchlistItem" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "stockCode" TEXT NOT NULL, "stockName" TEXT NOT NULL, "sector" TEXT,
            "market" TEXT NOT NULL DEFAULT 'DOMESTIC', "exchangeCode" TEXT, "isActive" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS "AgentLog" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "type" TEXT NOT NULL, "market" TEXT NOT NULL, "message" TEXT NOT NULL, "details" TEXT, "sessionId" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS "RiskConfig" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "maxPositionSize" DOUBLE PRECISION NOT NULL DEFAULT 0.1, "maxDailyLoss" DOUBLE PRECISION NOT NULL DEFAULT 0.03,
            "maxTotalLoss" DOUBLE PRECISION NOT NULL DEFAULT 0.1, "maxOpenPositions" INTEGER NOT NULL DEFAULT 5,
            "stopLossPercent" DOUBLE PRECISION NOT NULL DEFAULT 0.05, "takeProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
            "trailingStopPercent" DOUBLE PRECISION NOT NULL DEFAULT 0.03, "isActive" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS "MarketData" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "stockCode" TEXT NOT NULL, "date" TEXT NOT NULL,
            "open" DOUBLE PRECISION NOT NULL, "high" DOUBLE PRECISION NOT NULL, "low" DOUBLE PRECISION NOT NULL, "close" DOUBLE PRECISION NOT NULL,
            "volume" INTEGER NOT NULL, "market" TEXT NOT NULL DEFAULT 'DOMESTIC', "exchangeCode" TEXT,
            "currency" TEXT NOT NULL DEFAULT 'KRW', "exchangeRate" DOUBLE PRECISION,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "MarketData_stockCode_date_key" UNIQUE ("stockCode", "date")
          )`,
          `CREATE TABLE IF NOT EXISTS "TradingStrategy" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "name" TEXT NOT NULL, "description" TEXT, "type" TEXT NOT NULL, "parameters" TEXT NOT NULL,
            "isActive" BOOLEAN NOT NULL DEFAULT false, "profitRate" DOUBLE PRECISION, "winRate" DOUBLE PRECISION,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS "AppSetting" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "key" TEXT NOT NULL UNIQUE,
            "value" JSONB,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
        ];

        for (const stmt of createStatements) {
          try {
            await client.$executeRawUnsafe(stmt);
          } catch (stmtError) {
            // CREATE TABLE IF NOT EXISTS는 테이블이 이미 있으면 에러가 아니므로
            // 다른 에러만 로깅
            const errMsg = stmtError instanceof Error ? stmtError.message : String(stmtError);
            if (!errMsg.includes('already exists')) {
              console.warn(`[DB] SQL statement failed: ${errMsg.substring(0, 200)}`);
            }
          }
        }
        console.log('[DB] All CREATE TABLE statements executed');

        // 테이블 재확인
        const recheck = await client.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name` as any[];
        const newTableNames = recheck?.map((r: any) => r.table_name) || [];
        console.log('[DB] Tables after creation:', newTableNames.join(', '));

        _prismaClient = client;
        return true;
      } catch (sqlError) {
        console.warn('[DB] Raw SQL table creation failed:', sqlError instanceof Error ? sqlError.message : String(sqlError));
      }

      await client.$disconnect().catch(() => {});
      return false;
    } catch (queryError) {
      console.warn('[DB] Prisma connected but schema check failed, falling back to in-memory:', queryError);
      await client.$disconnect().catch(() => {});
      return false;
    }
  } catch (error) {
    console.warn('[DB] Prisma connection failed, using in-memory database:', error);
    return false;
  }
}

// 동기적으로 DB 객체를 제공
// Prisma 연결은 비동기이므로, 초기에는 인메모리 DB를 사용하고
// 백그라운드에서 Prisma 연결을 시도합니다.

function getInMemoryDb() {
  if (!_inMemoryDb) {
    _inMemoryDb = createInMemoryDb();
    console.log('[DB] In-memory database initialized');
  }
  return _inMemoryDb;
}

// Prisma가 성공하면 교체
async function trySwitchToPrisma() {
  const success = await initPrisma();
  if (success) {
    _usePrisma = true;
    console.log('[DB] Switched to Prisma (PostgreSQL)');
  }
}

// 백그라운드에서 Prisma 연결 시도 (실패해도 앱은 정상 동작)
if (typeof window === 'undefined') {
  // 서버 사이드에서만 실행
  trySwitchToPrisma().catch(() => {});
}

// 실제 DB 객체 - Prisma가 준비되면 PrismaClient, 아니면 인메모리
export const db = new Proxy({} as any, {
  get: (_target, prop) => {
    // 실제 DB를 반환
    const actualDb = _usePrisma && _prismaClient ? _prismaClient : getInMemoryDb();
    return actualDb[prop];
  }
});

export const isDbAvailable = () => _usePrisma && !!_prismaClient;
export const getDbType = () => _usePrisma ? 'PostgreSQL' : 'InMemory';
