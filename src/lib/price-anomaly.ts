// 가격 anomaly 검증 유틸리티
// ─────────────────────────────────────────────────────────────
// 분석 기준가(캔들 종가)와 KIS 실시간 현재가가 20% 이상 괴리하면:
//   - signal.priceAnomaly = true
//   - 신규 주문 금지
//   - 자동 청산 금지
//   - recentLogs에 경고 출력
//
// 사용자 신고 케이스 (삼성전자 005930):
//   - signal.price = 370,750원 (캔들 lastClose)
//   - KIS 현재가 = 70,100원 (정상)
//   - 괴리율 = (370750 - 70100) / 70100 = 428.7% → priceAnomaly=true
//
// 원인 가설:
//   1) KIS 일봉 API의 FID_ORG_ADJ_PRC=1 (원주가) 응답이 액면분할 전 가격을 반환
//   2) KIS 일봉 응답의 stck_clpr 필드가 단위 보정 없이 원본 int로 파싱됨
//   3) 수정주가/원주가 혼용으로 분할 전/후 가격이 섞임
//
// 본 모듈은 검증만 수행 — 실제 파싱 버그는 별도 수정 필요

import type { TradingSignal } from './types';

export const PRICE_ANOMALY_THRESHOLD = 0.20; // 20% 괴리 시 anomaly

export interface PriceAnomalyResult {
  priceAnomaly: boolean;
  anomalyReason: string;
  anomalyCheckedAt: string;
  gapPercent: number; // 절대값 (0.0 ~ 1.0+)
  analysisPrice: number;
  realtimePrice: number;
}

/**
 * 분석 기준가(signal.price 또는 analysisPrice)와 실시간 현재가를 비교하여
 * 20% 이상 괴리 시 priceAnomaly=true 반환
 *
 * @param analysisPrice 분석 기준가 (캔들 종가)
 * @param realtimePrice KIS 실시간 현재가
 * @param stockCode 종목코드 (로깅용)
 * @param stockName 종목명 (로깅용)
 */
export function checkPriceAnomaly(
  analysisPrice: number | undefined | null,
  realtimePrice: number | undefined | null,
  stockCode: string,
  stockName: string,
): PriceAnomalyResult {
  const now = new Date().toISOString();
  const a = typeof analysisPrice === 'number' && analysisPrice > 0 ? analysisPrice : 0;
  const r = typeof realtimePrice === 'number' && realtimePrice > 0 ? realtimePrice : 0;

  // 둘 중 하나라도 0 이하면 검증 불가 → anomaly 아님 (별도 경고는 호출자 측)
  if (a <= 0 || r <= 0) {
    return {
      priceAnomaly: false,
      anomalyReason: '',
      anomalyCheckedAt: now,
      gapPercent: 0,
      analysisPrice: a,
      realtimePrice: r,
    };
  }

  const gapPercent = Math.abs(a - r) / Math.min(a, r);
  // 20% 이상 괴리 시 anomaly
  if (gapPercent >= PRICE_ANOMALY_THRESHOLD) {
    return {
      priceAnomaly: true,
      anomalyReason:
        `가격 괴리 ${((gapPercent * 100)).toFixed(2)}% — ` +
        `분석기준가=${a} vs 실시간현재가=${r} ` +
        `(stockCode=${stockCode}, stockName=${stockName}). ` +
        `원인 가능성: 액면분할/수정주가 혼용, KIS 일봉 원주가 파싱, 단위 보정 누락. ` +
        `신규 주문 및 자동 청산 차단됨.`,
      anomalyCheckedAt: now,
      gapPercent,
      analysisPrice: a,
      realtimePrice: r,
    };
  }

  return {
    priceAnomaly: false,
    anomalyReason: '',
    anomalyCheckedAt: now,
    gapPercent,
    analysisPrice: a,
    realtimePrice: r,
  };
}

/**
 * TradingSignal에 priceAnomaly 정보를 주입
 * (signal.price 또는 analysisPrice vs signal.currentPrice 비교)
 *
 * @returns anomaly 적용된 signal (새 객체 아님 — in-place 수정)
 */
export function applyPriceAnomalyToSignal(
  signal: TradingSignal,
  realtimePrice?: number | null,
): TradingSignal {
  const analysisPrice = signal.analysisPrice ?? signal.price;
  const realtime = realtimePrice ?? signal.currentPrice ?? 0;

  const result = checkPriceAnomaly(
    analysisPrice,
    realtime,
    signal.stockCode,
    signal.stockName,
  );

  signal.priceAnomaly = result.priceAnomaly;
  signal.anomalyReason = result.anomalyReason;
  signal.anomalyCheckedAt = result.anomalyCheckedAt;

  return signal;
}
