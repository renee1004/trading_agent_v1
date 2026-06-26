// 가격 anomaly 검증 유틸리티
// ─────────────────────────────────────────────────────────────
// **priceAnomaly의 정의 (가격 소스 간 비교만 해당):**
//   - 캔들 종가(analysisPrice) vs KIS 실시간 현재가(realtimePrice)
//   - KIS quote currentPrice vs KIS balance currentPrice
//   - realtimeQuotePrice vs candleLastClose
//   - realtimeQuotePrice vs position.currentPrice
//
// **priceAnomaly가 아닌 것 (손익률):**
//   - avgPrice vs currentPrice 차이 → 이는 손실률/수익률이며 priceAnomaly가 아님
//   - 평균매입단가와 현재가의 괴리는 정상적인 시장 변동이므로 자동청산 차단에 사용 금지
//
// priceAnomaly=true인 경우:
//   - 신규 주문 금지 (캔들 종가와 실시간 가격이 20% 이상 괴리 = 데이터 오류)
//   - 자동 청산은 priceAnomaly로 차단하지 않음 (autoExitEnabled로 제어)
//
// 사용자 신고 케이스 (삼성전자 005930):
//   - signal.price = 370,750원 (캔들 lastClose)
//   - KIS 현재가 = 70,100원 (정상)
//   - 괴리율 = (370750 - 70100) / 70100 = 428.7% → priceAnomaly=true
//
// 반례: 현대건설 000720
//   - avgPrice = 140,012원 (KIS 평균단가 — 정상)
//   - currentPrice = 108,600원 (KIS 현재가 — 정상)
//   - 차이 = -22.51% → 이는 손실률이며 priceAnomaly가 아님!

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
