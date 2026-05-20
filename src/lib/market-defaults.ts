// 시장별 전략 기본 파라미터 & 리스크 설정
// 국내주식(KOSPI/KOSDAQ)과 해외주식(미국 나스닥/뉴욕)의 시장 구조 차이를 반영

import { MarketStrategyDefaults, MarketRiskDefaults, RiskConfig } from './types';

/**
 * 국내주식 전략 기본 파라미터
 * 
 * 특징:
 * - 상하한가 제한 (±30%) → 변동성이 상대적으로 제한됨
 * - 데이트레이딩 비중 높음 → 변동성 돌파 전략 가중치 높음
 * - 거래량 급증이 세력 매집 신호로 유의미 → 모멘텀 임계값 높음
 * - RSI 과매도/과매수 기준이 정통 (30/70)
 * - BB 표준편차 2.0 (정상 범위)
 */
export const DOMESTIC_STRATEGY_DEFAULTS: MarketStrategyDefaults = {
  composite: {
    atrPeriod: 10,
    atrMultiplier: 3.0,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bbPeriod: 20,
    bbStdDev: 2.0,
    maShort: 5,
    maLong: 20,
  },
  volatilityBreakout: {
    volatilityK: 0.5,         // 래리 윌리엄스 표준 k값
    stopLoss: 0.03,           // 3% (상하한가 내에서 타이트)
    takeProfit: 0.10,         // 10%
    minVolumeRatio: 1.5,      // 거래량 1.5배 이상
  },
  superTrend: {
    atrPeriod: 10,
    atrMultiplier: 3.0,
    rsiPeriod: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
  },
  meanReversion: {
    bbPeriod: 20,
    bbStdDev: 2.0,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
  },
  momentum: {
    rsiPeriod: 14,
    maShort: 5,
    maLong: 20,
    volumeSpikeThreshold: 2.0, // 거래량 2배 이상 폭증
    minConsecutiveDays: 2,     // 2일 연속 상승
  },
  // 국내: 변동성 돌파 가중치 상대적으로 높음 (데이트레이딩 검증)
  strategyWeights: {
    COMPOSITE: 0.35,
    SUPER_TREND: 0.20,
    VOLATILITY_BREAKOUT: 0.20,  // 국내에서 검증된 전략
    MEAN_REVERSION: 0.15,
    MOMENTUM: 0.10,
  },
};

/**
 * 해외주식(미국) 전략 기본 파라미터
 * 
 * 특징:
 * - 상하한가 없음 → 하루 10~20% 변동 가능 → 손절 폭 넓게
 * - 추세 지속력 강함 → SuperTrend 가중치 높임
 * - 거래량이 기본적으로 큼 → 거래량 폭증 임계값 낮춤
 * - RSI 과매수 구간 상향 (80) → 미국 테크주는 RSI 70 넘어도 계속 오름
 * - BB 표준편차 2.5 → 변동성이 더 크므로 밴드를 넓게
 * - ATR Multiplier 4.0 → 가격 변동이 커서 더 넓은 스톱 필요
 * - 환율 리스크 → 포지션 사이즈 축소, 손절 버퍼 추가
 */
export const OVERSEAS_STRATEGY_DEFAULTS: MarketStrategyDefaults = {
  composite: {
    atrPeriod: 14,             // 더 긴 주기로 안정성 확보
    atrMultiplier: 4.0,        // 변동성이 크므로 더 넓은 밴드
    rsiPeriod: 14,
    rsiOverbought: 75,         // 75로 상향 (미국 테크주는 70 넘어도 오름)
    rsiOversold: 25,           // 25로 하향 (더 깊은 조정 대기)
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bbPeriod: 20,
    bbStdDev: 2.5,             // 변동성이 크므로 밴드를 넓게
    maShort: 10,               // 5일 → 10일 (단기 노이즈 필터링)
    maLong: 30,                // 20일 → 30일 (더 긴 추세 확인)
  },
  volatilityBreakout: {
    volatilityK: 0.4,          // 0.5 → 0.4 (미국은 변동성이 커서 보수적)
    stopLoss: 0.05,            // 5% (상하한가 없으므로 더 넉넉히)
    takeProfit: 0.15,          // 15% (더 큰 움직임 기대)
    minVolumeRatio: 1.3,       // 1.3배 (미국은 기본 거래량이 큼)
  },
  superTrend: {
    atrPeriod: 14,             // 14일 (더 긴 주기로 추세 안정성)
    atrMultiplier: 4.0,        // 4.0 (변동성이 큰 미국 시장에 맞춤)
    rsiPeriod: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
  },
  meanReversion: {
    bbPeriod: 20,
    bbStdDev: 2.5,             // 더 넓은 밴드
    rsiPeriod: 14,
    rsiOverbought: 80,         // 80으로 상향 (강한 추세 지속 시 대기)
    rsiOversold: 20,           // 20으로 하향 (더 깊은 과매도 기다림)
  },
  momentum: {
    rsiPeriod: 14,
    maShort: 10,
    maLong: 30,
    volumeSpikeThreshold: 1.5, // 1.5배 (미국은 기본 거래량이 큼)
    minConsecutiveDays: 3,     // 3일 연속 (추세 확인 강화)
  },
  // 해외: SuperTrend 가중치 높임 (추세 지속력 강함)
  strategyWeights: {
    COMPOSITE: 0.30,
    SUPER_TREND: 0.30,          // 미국 시장은 추세 추종이 핵심
    VOLATILITY_BREAKOUT: 0.10,  // 미국은 상하한가 없어 변동성돌파 위험
    MEAN_REVERSION: 0.15,
    MOMENTUM: 0.15,             // 모멘텀 가중치 상향 (거래량 신호 유의미)
  },
};

/**
 * 국내주식 리스크 기본 설정
 */
export const DOMESTIC_RISK_DEFAULTS: MarketRiskDefaults = {
  maxPositionSize: 0.10,       // 포지션당 10%
  maxDailyLoss: 0.03,          // 일일 최대 손실 3%
  maxTotalLoss: 0.10,          // 총 최대 손실 10%
  maxOpenPositions: 5,         // 최대 5개 포지션
  stopLossPercent: 0.05,       // 손절 5%
  takeProfitPercent: 0.15,     // 익절 15%
  trailingStopPercent: 0.03,   // 트레일링 스톱 3%
  exchangeRateBuffer: 0,       // 국내는 환율 리스크 없음
};

/**
 * 해외주식 리스크 기본 설정
 * 
 * 주요 차이:
 * - 포지션 사이즈 축소 (7% vs 10%) → 환율 리스크 + 높은 변동성
 * - 손절 폭 넓힘 (7% vs 5%) → 상하한가 없음, 갭 리스크
 * - 익절 폭 넓힘 (20% vs 15%) → 더 큰 움직임
 * - 트레일링 스톱 넓힘 (5% vs 3%) → 일봉 기준 변동성 큼
 * - 환율 버퍼 1.5% → USD/KRW 변동 리스크 흡수
 */
export const OVERSEAS_RISK_DEFAULTS: MarketRiskDefaults = {
  maxPositionSize: 0.07,       // 7% (환율리스크 + 높은 변동성)
  maxDailyLoss: 0.04,          // 4% (변동성이 커서 약간 넉넉히)
  maxTotalLoss: 0.12,          // 12%
  maxOpenPositions: 4,         // 4개 (집중 관리)
  stopLossPercent: 0.07,       // 7% (상하한가 없음, 갭 리스크)
  takeProfitPercent: 0.20,     // 20% (더 큰 움직임 기대)
  trailingStopPercent: 0.05,   // 5% (변동성에 맞춰 넓게)
  exchangeRateBuffer: 0.015,   // 1.5% 환율 변동 버퍼
};

/**
 * 시장별 기본값 조회 헬퍼
 */
export function getMarketDefaults(market: 'DOMESTIC' | 'OVERSEAS') {
  return {
    strategy: market === 'DOMESTIC' 
      ? DOMESTIC_STRATEGY_DEFAULTS 
      : OVERSEAS_STRATEGY_DEFAULTS,
    risk: market === 'DOMESTIC'
      ? DOMESTIC_RISK_DEFAULTS
      : OVERSEAS_RISK_DEFAULTS,
  };
}

/**
 * 시장별 RiskConfig 변환
 */
export function getMarketRiskConfig(market: 'DOMESTIC' | 'OVERSEAS'): RiskConfig {
  const defaults = getMarketDefaults(market).risk;
  return {
    maxPositionSize: defaults.maxPositionSize,
    maxDailyLoss: defaults.maxDailyLoss,
    maxTotalLoss: defaults.maxTotalLoss,
    maxOpenPositions: defaults.maxOpenPositions,
    stopLossPercent: defaults.stopLossPercent,
    takeProfitPercent: defaults.takeProfitPercent,
    trailingStopPercent: defaults.trailingStopPercent,
  };
}

/**
 * 시장별 전략 파라미터를 StrategyParameters로 변환 (복합 지표 전략용)
 */
export function getCompositeParams(market: 'DOMESTIC' | 'OVERSEAS') {
  const d = getMarketDefaults(market).strategy.composite;
  return {
    atrPeriod: d.atrPeriod,
    atrMultiplier: d.atrMultiplier,
    rsiPeriod: d.rsiPeriod,
    rsiOverbought: d.rsiOverbought,
    rsiOversold: d.rsiOversold,
    macdFast: d.macdFast,
    macdSlow: d.macdSlow,
    macdSignal: d.macdSignal,
    bbPeriod: d.bbPeriod,
    bbStdDev: d.bbStdDev,
    maShort: d.maShort,
    maLong: d.maLong,
  };
}

/**
 * 시장별 전략 가중치 조회
 */
export function getStrategyWeights(market: 'DOMESTIC' | 'OVERSEAS') {
  return getMarketDefaults(market).strategy.strategyWeights;
}

/**
 * 두 시장의 주요 차이점 요약 (UI 표시용)
 */
export const MARKET_COMPARISON = {
  DOMESTIC: {
    name: '국내주식',
    features: [
      '상하한가 ±30% 제한 → 손절 타이트 가능',
      '변동성 돌파 전략 검증됨 (데이트레이딩)',
      'RSI 30/70 정통 기준 적용',
      'BB 표준편차 2.0',
      '거래량 폭증 2배 이상이 의미 있음',
      '환율 리스크 없음',
    ],
    bestStrategies: ['VOLATILITY_BREAKOUT', 'COMPOSITE'],
    riskLevel: 'MEDIUM',
  },
  OVERSEAS: {
    name: '해외주식 (미국)',
    features: [
      '상하한가 없음 → 하루 10~20% 변동 가능',
      '추세 지속력 강함 → SuperTrend 전략 강화',
      'RSI 25/75 완화 기준 (과매수/과매도 깊어야 신호)',
      'BB 표준편차 2.5 (변동성 큼)',
      '거래량 폭증 1.5배로 충분 (기본 거래량 큼)',
      '환율 리스크 1~2% 추가 고려',
    ],
    bestStrategies: ['SUPER_TREND', 'MOMENTUM'],
    riskLevel: 'HIGH',
  },
} as const;
