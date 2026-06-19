-- Migration: TradeHistory v2 필드 추가
-- 목적: 주문 출처 및 실행 모드, 가격 상세, KIS API 응답 필드 추가
-- 안전하게 ADD COLUMN IF NOT EXISTS 사용 — nullable 또는 기본값 있음

-- 주문 출처 (AGENT, MANUAL, TEST)
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'AGENT';

-- 주문 실행 모드 (DRY_RUN, PAPER, LIVE)
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderExecutionMode" TEXT NOT NULL DEFAULT 'DRY_RUN';

-- 주문 직전 실시간 현재가
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "currentPrice" DOUBLE PRECISION;

-- 주문 입력 가격
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "orderPrice" DOUBLE PRECISION;

-- 체결 가격
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "filledPrice" DOUBLE PRECISION;

-- 평균 체결 가격
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "avgFillPrice" DOUBLE PRECISION;

-- 슬리피지 (%): (filledPrice - orderPrice) / orderPrice * 100
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "slippagePercent" DOUBLE PRECISION;

-- KIS API rt_cd
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "rtCd" TEXT;

-- KIS API msg_cd
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msgCd" TEXT;

-- KIS API msg1
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "msg1" TEXT;
