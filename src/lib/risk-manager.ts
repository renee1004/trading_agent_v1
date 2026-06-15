// 리스크 관리 모듈
// 포지션 사이즈, 손절, 익절, 최대 손실 등 관리
// 시장별(DOMESTIC/OVERSEAS) 차별화된 리스크 파라미터 적용
// v2: ATR 기반 손절폭, 리스크 기반 포지션 사이즈, SELL 보유 확인, 분할 익절

import { RiskConfig, TradingSignal, BalanceItem, MarketType } from './types';
import { getMarketRiskConfig, OVERSEAS_RISK_DEFAULTS } from './market-defaults';

export class RiskManager {
  private config: RiskConfig;
  private market: MarketType;
  private dailyPnL: number = 0;
  private totalPnL: number = 0;
  private dailyStartDate: string = '';
  private minConfidenceThreshold: number = 50;

  constructor(config: RiskConfig, market: MarketType = 'DOMESTIC', minConfidenceThreshold?: number) {
    this.config = config;
    this.market = market;
    if (minConfidenceThreshold !== undefined) {
      this.minConfidenceThreshold = minConfidenceThreshold;
    }
  }

  /**
   * 시장별 기본 리스크 설정으로 RiskManager 생성
   */
  static createForMarket(market: MarketType): RiskManager {
    const config = getMarketRiskConfig(market);
    return new RiskManager(config, market);
  }

  /**
   * 리스크 설정 업데이트
   */
  updateConfig(config: Partial<RiskConfig>) {
    this.config = { ...this.config, ...config };
  }

  /**
   * 매매 가능 여부 확인
   * v2: SELL 신호 시 보유 여부 확인 추가
   */
  canTrade(
    signal: TradingSignal,
    currentPositions: BalanceItem[],
    accountBalance: number
  ): { allowed: boolean; reason: string } {
    // 일일 손실 한도 체크
    this.checkDailyReset();
    
    if (this.dailyPnL < 0 && Math.abs(this.dailyPnL) > accountBalance * this.config.maxDailyLoss) {
      return { 
        allowed: false, 
        reason: `일일 최대 손실 초과 (손실: ${this.formatMoney(this.dailyPnL)}, 한도: ${this.formatMoney(accountBalance * this.config.maxDailyLoss)})` 
      };
    }

    // 총 손실 한도 체크
    if (this.totalPnL < 0 && Math.abs(this.totalPnL) > accountBalance * this.config.maxTotalLoss) {
      return { 
        allowed: false, 
        reason: `총 최대 손실 초과 (손실: ${this.formatMoney(this.totalPnL)}, 한도: ${this.formatMoney(accountBalance * this.config.maxTotalLoss)})` 
      };
    }

    // 최대 포지션 수 체크 (BUY만)
    if (signal.signalType === 'BUY' && currentPositions.length >= this.config.maxOpenPositions) {
      return { 
        allowed: false, 
        reason: `최대 포지션 수 초과 (${currentPositions.length}/${this.config.maxOpenPositions})` 
      };
    }

    // 동일 종목 중복 매수 방지
    if (signal.signalType === 'BUY') {
      const existingPosition = currentPositions.find(p => p.stockCode === signal.stockCode);
      if (existingPosition) {
        return { 
          allowed: false, 
          reason: `${signal.stockName} 이미 보유 중` 
        };
      }
    }

    // v2: SELL 신호 시 보유 확인 — 미보유 SELL은 주문 차단
    if (signal.signalType === 'SELL') {
      const heldPosition = currentPositions.find(p => p.stockCode === signal.stockCode);
      if (!heldPosition) {
        return {
          allowed: false,
          reason: `${signal.stockName} 미보유 — SELL 주문 불가 (매수 회피 신호로만 기록)`,
        };
      }
    }

    // 신뢰도 필터 (strategyAggressiveness에 따른 동적 임계값)
    if (signal.confidence < this.minConfidenceThreshold) {
      return {
        allowed: false,
        reason: `신뢰도 낮음 (${signal.confidence}% < ${this.minConfidenceThreshold}%)`,
      };
    }

    return { allowed: true, reason: '매매 가능' };
  }

  /**
   * 포지션 사이즈 계산 — v2: ATR 기반 리스크 포지션 사이징
   * 
   * 기본 원리:
   * - 1회 거래 허용 손실 = 계좌 평가금 × accountRiskPercent (0.3~0.5%)
   * - 손절폭(stopDistance) = ATR × multiplier (변동성 기반) 또는 고정 %
   * - 포지션 수량 = 허용 손실 / 손절폭
   * 
   * 기본 1.0% 리스크 기반 포지션 사이즈 계산
   */
  calculatePositionSize(
    accountBalance: number,
    price: number,
    confidence: number,
    atrValue?: number,
    accountRiskPercent: number = 1.0,
    useATRStop: boolean = false,
  ): number {
    // accountRiskPercent가 0 이하이면 1주 반환 (안전장치)
    if (accountRiskPercent <= 0) {
      return 1;
    }

    // 1회 거래 허용 손실금액
    const riskAmount = accountBalance * (accountRiskPercent / 100);

    let stopDistance: number;

    if (useATRStop && atrValue && atrValue > 0) {
      // ATR 기반 손절폭: ATR × 1.5 (변동성에 적응)
      stopDistance = atrValue * 1.5;
    } else {
      // 고정 % 기반 손절폭
      const exchangeBuffer = this.market === 'OVERSEAS' 
        ? OVERSEAS_RISK_DEFAULTS.exchangeRateBuffer 
        : 0;
      stopDistance = price * (this.config.stopLossPercent + exchangeBuffer);
    }

    // 손절폭이 최소 가격의 1% 이하면 안전 마진
    stopDistance = Math.max(stopDistance, price * 0.01);

    // 리스크 기반 수량 = 허용 손실 / 손절폭
    const quantity = Math.floor(riskAmount / stopDistance);

    // 최대 포지션 비율 제한 (계좌의 maxPositionSize% 이하)
    const exchangeBuffer = this.market === 'OVERSEAS' 
      ? OVERSEAS_RISK_DEFAULTS.exchangeRateBuffer 
      : 0;
    const effectiveBalance = accountBalance * (1 - exchangeBuffer);
    const maxAmount = effectiveBalance * this.config.maxPositionSize;
    const maxQuantityBySize = Math.floor(maxAmount / price);

    // 신뢰도에 따른 축소 (보수적 조정)
    const confidenceFactor = Math.min(confidence / 100, 1.0);
    const adjustedMaxQuantity = Math.max(1, Math.floor(maxQuantityBySize * confidenceFactor));

    // 리스크 기반 수량과 최대 비율 기반 수량 중 작은 값
    const finalQuantity = Math.min(
      Math.max(1, quantity),
      adjustedMaxQuantity
    );

    return finalQuantity;
  }

  /**
   * ATR 기반 손절가 계산
   * stopLoss = entryPrice - ATR × multiplier
   */
  calculateATRStopLoss(entryPrice: number, atrValue: number, multiplier: number = 1.5): number {
    if (!atrValue || atrValue <= 0) {
      return this.calculateStopLoss(entryPrice);
    }
    return Math.floor(entryPrice - atrValue * multiplier);
  }

  /**
   * 손절가 계산
   * 해외주식은 상하한가가 없으므로 손절 폭을 더 넓게 설정
   */
  calculateStopLoss(entryPrice: number, strategy: string = 'default'): number {
    let stopLossPercent = this.config.stopLossPercent;
    
    // 전략별 손절 폭 조정
    switch (strategy) {
      case 'VOLATILITY_BREAKOUT':
        stopLossPercent = this.market === 'OVERSEAS' ? 0.05 : 0.03;
        break;
      case 'SUPER_TREND':
        stopLossPercent = this.market === 'OVERSEAS' ? 0.07 : 0.05;
        break;
      case 'MEAN_REVERSION':
        stopLossPercent = this.market === 'OVERSEAS' ? 0.06 : 0.04;
        break;
      case 'COMPOSITE':
        stopLossPercent = this.market === 'OVERSEAS' ? 0.07 : 0.05;
        break;
    }

    // 해외주식: 환율 버퍼만큼 손절가 추가 하향
    const exchangeBuffer = this.market === 'OVERSEAS' 
      ? OVERSEAS_RISK_DEFAULTS.exchangeRateBuffer 
      : 0;
    
    return Math.floor(entryPrice * (1 - stopLossPercent - exchangeBuffer));
  }

  /**
   * 익절가 계산
   * 해외주식은 변동성이 커서 익절 목표를 더 높게 설정
   */
  calculateTakeProfit(entryPrice: number, strategy: string = 'default'): number {
    let takeProfitPercent = this.config.takeProfitPercent;
    
    switch (strategy) {
      case 'VOLATILITY_BREAKOUT':
        takeProfitPercent = this.market === 'OVERSEAS' ? 0.15 : 0.10;
        break;
      case 'SUPER_TREND':
        takeProfitPercent = this.market === 'OVERSEAS' ? 0.25 : 0.20;
        break;
      case 'MEAN_REVERSION':
        takeProfitPercent = this.market === 'OVERSEAS' ? 0.12 : 0.08;
        break;
      case 'COMPOSITE':
        takeProfitPercent = this.market === 'OVERSEAS' ? 0.20 : 0.15;
        break;
    }

    return Math.floor(entryPrice * (1 + takeProfitPercent));
  }

  /**
   * 트레일링 스톱 계산
   */
  calculateTrailingStop(
    entryPrice: number,
    currentHighPrice: number,
    strategy: string = 'default'
  ): number {
    const trailingPercent = this.config.trailingStopPercent;
    
    if (currentHighPrice <= entryPrice) {
      return this.calculateStopLoss(entryPrice, strategy);
    }
    
    return Math.floor(currentHighPrice * (1 - trailingPercent));
  }

  /**
   * 일일 손실 업데이트
   */
  updateDailyPnL(pnl: number) {
    this.checkDailyReset();
    this.dailyPnL += pnl;
    this.totalPnL += pnl;
  }

  /**
   * 포지션 익절/손절 체크 — v2: 분할 익절 + ATR 손절 + 트레일링스탑
   * 
   * 분할 익절 (partialTakeProfit 활성화 시):
   * - +2% → 30% 익절 (1차)
   * - +4% → 30% 익절 (2차)
   * - 나머지 → 트레일링 스톱 (3%)
   * 
   * 손절:
   * - ATR 모드: entryPrice - ATR×1.5
   * - 기본: entryPrice × (1 - stopLossPercent)
   */
  checkPositionExit(
    position: BalanceItem,
    currentPrice: number,
    entryPrice: number,
    highSinceEntry: number,
    strategy: string = 'default',
    partialExitCount: number = 0,
    partialTakeProfit: boolean = false,
    atrValue?: number,
    useATRStop: boolean = false,
  ): { shouldExit: boolean; reason: string; exitPrice: number; exitQuantity?: number } {
    // 손절가 계산 (ATR 또는 고정%)
    const stopLoss = useATRStop && atrValue && atrValue > 0
      ? this.calculateATRStopLoss(entryPrice, atrValue)
      : this.calculateStopLoss(entryPrice, strategy);

    // 손절 체크 — 무조건 전량 청산
    if (currentPrice <= stopLoss) {
      return { shouldExit: true, reason: `손절가 도달 (${currentPrice} ≤ ${stopLoss})`, exitPrice: currentPrice };
    }

    const profitRate = (currentPrice - entryPrice) / entryPrice;

    // 분할 익절 모드
    if (partialTakeProfit) {
      // 1차 익절: +2% → 30% 포지션 청산
      if (profitRate >= 0.02 && partialExitCount === 0) {
        return { shouldExit: true, reason: `1차 익절 (+${(profitRate * 100).toFixed(1)}%)`, exitPrice: currentPrice, exitQuantity: Math.max(1, Math.ceil(position.quantity * 0.3)) };
      }
      // 2차 익절: +4% → 30% 포지션 청산
      if (profitRate >= 0.04 && partialExitCount === 1) {
        return { shouldExit: true, reason: `2차 익절 (+${(profitRate * 100).toFixed(1)}%)`, exitPrice: currentPrice, exitQuantity: Math.max(1, Math.ceil(position.quantity * 0.3)) };
      }
      // 이후 트레일링 스톱
      const trailingStop = this.calculateTrailingStop(entryPrice, highSinceEntry, strategy);
      if (currentPrice <= trailingStop && highSinceEntry > entryPrice * 1.02) {
        return { shouldExit: true, reason: `트레일링 스톱 (고점 대비 -${((1 - currentPrice / highSinceEntry) * 100).toFixed(1)}%)`, exitPrice: currentPrice };
      }
    } else {
      // 기존 단일 익절 모드
      const takeProfit = this.calculateTakeProfit(entryPrice, strategy);
      if (currentPrice >= takeProfit) {
        return { shouldExit: true, reason: '익절가 도달', exitPrice: currentPrice };
      }
      const trailingStop = this.calculateTrailingStop(entryPrice, highSinceEntry, strategy);
      if (currentPrice <= trailingStop && highSinceEntry > entryPrice * 1.05) {
        return { shouldExit: true, reason: '트레일링 스톱', exitPrice: currentPrice };
      }
    }

    return { shouldExit: false, reason: '', exitPrice: 0 };
  }

  /**
   * 일일 리셋 체크
   */
  private checkDailyReset() {
    const today = new Date().toISOString().split('T')[0];
    if (this.dailyStartDate !== today) {
      this.dailyPnL = 0;
      this.dailyStartDate = today;
    }
  }

  /**
   * 금액 포맷
   */
  private formatMoney(amount: number): string {
    return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(amount);
  }

  /**
   * 최소 신뢰도 임계값 업데이트
   */
  setMinConfidenceThreshold(threshold: number) {
    this.minConfidenceThreshold = threshold;
  }

  /**
   * 현재 리스크 상태 조회
   */
  getStatus() {
    this.checkDailyReset();
    return {
      dailyPnL: this.dailyPnL,
      totalPnL: this.totalPnL,
      config: this.config,
      minConfidenceThreshold: this.minConfidenceThreshold,
      dailyLossLimit: this.config.maxDailyLoss,
      totalLossLimit: this.config.maxTotalLoss,
    };
  }
}

/**
 * 기본 리스크 설정
 */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxPositionSize: 0.10,      // 포지션당 최대 10%
  maxDailyLoss: 0.03,         // 일일 최대 손실 3%
  maxTotalLoss: 0.10,         // 총 최대 손실 10%
  maxOpenPositions: 5,        // 최대 5개 포지션
  stopLossPercent: 0.05,      // 손절 5%
  takeProfitPercent: 0.15,    // 익절 15%
  trailingStopPercent: 0.03,  // 트레일링 스톱 3%
};
