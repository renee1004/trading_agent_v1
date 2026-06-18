-- Migration: Position v2 필드 추가
-- 목적: 청산 관리(highSinceEntry, stopLossPrice, takeProfitPrice, trailingStopPrice, entryATR, partialExitCount) + 분할 청산 손익(realizedPnL)
-- 안전하게 ADD COLUMN 수행 (IF NOT EXISTS 사용)
-- nullable 컬럼이므로 기존 데이터 손상 없음

-- 진입 후 최고가 (트레일링스탑용)
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "highSinceEntry" DOUBLE PRECISION;

-- 손절가
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "stopLossPrice" DOUBLE PRECISION;

-- 익절가
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "takeProfitPrice" DOUBLE PRECISION;

-- 트레일링스탑 현재 가격
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "trailingStopPrice" DOUBLE PRECISION;

-- 진입 시 ATR (ATR 기반 손절폭 계산용)
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryATR" DOUBLE PRECISION;

-- 분할 익절 횟수 (기본값 0)
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "partialExitCount" INTEGER NOT NULL DEFAULT 0;

-- 분할 청산 실현 손익
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "realizedPnL" DOUBLE PRECISION;

-- 백필: 기존 Position 레코드에 highSinceEntry = avgPrice 로 초기화
-- (과거 고점을 모르는 상태에서 트레일링스탑이 과도하게 조이는 것 방지)
UPDATE "Position" SET "highSinceEntry" = "avgPrice" WHERE "highSinceEntry" IS NULL;
