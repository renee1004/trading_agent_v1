-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "KisConfig" (
    "id" TEXT NOT NULL,
    "appKey" TEXT NOT NULL,
    "appSecret" TEXT NOT NULL,
    "accountNo" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT true,
    "accessToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KisConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingStrategy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "profitRate" DOUBLE PRECISION,
    "winRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "stockCode" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "sector" TEXT,
    "market" TEXT NOT NULL DEFAULT 'DOMESTIC',
    "exchangeCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeHistory" (
    "id" TEXT NOT NULL,
    "stockCode" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "tradeType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "strategy" TEXT,
    "profitLoss" DOUBLE PRECISION,
    "profitRate" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "orderNo" TEXT,
    "signalReason" TEXT,
    "market" TEXT NOT NULL DEFAULT 'DOMESTIC',
    "exchangeCode" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "tradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "stockCode" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "avgPrice" DOUBLE PRECISION NOT NULL,
    "currentPrice" DOUBLE PRECISION,
    "profitLoss" DOUBLE PRECISION,
    "profitRate" DOUBLE PRECISION,
    "strategy" TEXT,
    "market" TEXT NOT NULL DEFAULT 'DOMESTIC',
    "exchangeCode" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingSession" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "strategyId" TEXT,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "totalProfit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "winTrades" INTEGER NOT NULL DEFAULT 0,
    "lossTrades" INTEGER NOT NULL DEFAULT 0,
    "maxDrawdown" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskConfig" (
    "id" TEXT NOT NULL,
    "maxPositionSize" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "maxDailyLoss" DOUBLE PRECISION NOT NULL DEFAULT 0.03,
    "maxTotalLoss" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 5,
    "stopLossPercent" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "takeProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "trailingStopPercent" DOUBLE PRECISION NOT NULL DEFAULT 0.03,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketData" (
    "id" TEXT NOT NULL,
    "stockCode" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" INTEGER NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'DOMESTIC',
    "exchangeCode" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "exchangeRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConfig" (
    "id" TEXT NOT NULL,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "currentSessionId" TEXT,
    "schedulerMode" TEXT NOT NULL DEFAULT 'SERVER',
    "cycleIntervalMs" INTEGER NOT NULL DEFAULT 60000,
    "tradeOnlyMarketHours" BOOLEAN NOT NULL DEFAULT true,
    "domesticMarketOpen" TEXT NOT NULL DEFAULT '09:00',
    "domesticMarketClose" TEXT NOT NULL DEFAULT '15:30',
    "overseasMarketOpen" TEXT NOT NULL DEFAULT '23:30',
    "overseasMarketClose" TEXT NOT NULL DEFAULT '06:00',
    "totalCycles" INTEGER NOT NULL DEFAULT 0,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "dailyPnL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastCycleAt" TIMESTAMP(3),
    "lastCycleResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentLog" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketData_stockCode_date_key" ON "MarketData"("stockCode", "date");

