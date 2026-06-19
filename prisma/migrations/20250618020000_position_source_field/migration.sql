-- Position.source 필드 추가 (단가 출처 추적)
-- KIS_BALANCE, PAPER_TRADE, SEED, MANUAL
-- 기존 포지션은 모두 KIS_BALANCE 또는 MANUAL로 간주 (전략이 MANUAL이면 MANUAL, 그 외 KIS_BALANCE)
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'KIS_BALANCE';

-- 기존 strategy=MANUAL인 포지션은 source=MANUAL로 마이그레이션
UPDATE "Position" SET "source" = 'MANUAL' WHERE "strategy" = 'MANUAL' AND "source" = 'KIS_BALANCE';
