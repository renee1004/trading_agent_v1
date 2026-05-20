// 리스크 관리 모듈
// 포지션 사이즈, 손절, 익절, 최대 손실 등 관리

import { RiskConfig, TradingSignal, BalanceItem } from './types';

export class RiskManager {
  private config: RiskConfig;
  private dailyPnL: number = 0;
  private totalPnL: number = 0;
  private dailyStartDate: string = '';

  constructor(config: RiskConfig) {
    this.config = config;
  }

  /**
   * 리스크 설정 업데이트
   */
  updateConfig(config: Partial<RiskConfig>) {
    this.config = { ...this.config, ...config };
  }

  /**
   * 매매 가능 여부 확인
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

    // 최대 포지션 수 체크
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

    // 신뢰도 필터
    if (signal.confidence < 50) {
      return {
        allowed: false,
        reason: `신뢰도 낮음 (${signal.confidence}%)`,
      };
    }

    return { allowed: true, reason: '매매 가능' };
  }

  /**
   * 포지션 사이즈 계산 (Kelly Criterion 기반 보수적 적용)
   */
  calculatePositionSize(
    accountBalance: number,
    price: number,
    confidence: number
  ): number {
    // 기본 포지션 비율 = 최대 포지션 비율 * 신뢰도 비율
    const maxAmount = accountBalance * this.config.maxPositionSize;
    const confidenceFactor = confidence / 100;
    const positionAmount = maxAmount * confidenceFactor;
    
    // 주식 수량 계산
    const quantity = Math.floor(positionAmount / price);
    
    return Math.max(1, quantity);
  }

  /**
   * 손절가 계산
   */
  calculateStopLoss(entryPrice: number, strategy: string = 'default'): number {
    let stopLossPercent = this.config.stopLossPercent;
    
    // 전략별 손절 폭 조정
    switch (strategy) {
      case 'VOLATILITY_BREAKOUT':
        stopLossPercent = 0.03; // 변동성 돌파는 타이트
        break;
      case 'SUPER_TREND':
        stopLossPercent = 0.05; // 추세 추종은 넉넉히
        break;
      case 'MEAN_REVERSION':
        stopLossPercent = 0.04;
        break;
      case 'COMPOSITE':
        stopLossPercent = 0.05;
        break;
    }

    return Math.floor(entryPrice * (1 - stopLossPercent));
  }

  /**
   * 익절가 계산
   */
  calculateTakeProfit(entryPrice: number, strategy: string = 'default'): number {
    let takeProfitPercent = this.config.takeProfitPercent;
    
    switch (strategy) {
      case 'VOLATILITY_BREAKOUT':
        takeProfitPercent = 0.10;
        break;
      case 'SUPER_TREND':
        takeProfitPercent = 0.20;
        break;
      case 'MEAN_REVERSION':
        takeProfitPercent = 0.08;
        break;
      case 'COMPOSITE':
        takeProfitPercent = 0.15;
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
   * 포지션 익절/손절 체크
   */
  checkPositionExit(
    position: BalanceItem,
    currentPrice: number,
    entryPrice: number,
    highSinceEntry: number,
    strategy: string = 'default'
  ): { shouldExit: boolean; reason: string; exitPrice: number } {
    const stopLoss = this.calculateStopLoss(entryPrice, strategy);
    const takeProfit = this.calculateTakeProfit(entryPrice, strategy);
    const trailingStop = this.calculateTrailingStop(entryPrice, highSinceEntry, strategy);

    if (currentPrice <= stopLoss) {
      return { shouldExit: true, reason: '손절가 도달', exitPrice: currentPrice };
    }

    if (currentPrice >= takeProfit) {
      return { shouldExit: true, reason: '익절가 도달', exitPrice: currentPrice };
    }

    if (currentPrice <= trailingStop && highSinceEntry > entryPrice * 1.05) {
      return { shouldExit: true, reason: '트레일링 스톱', exitPrice: currentPrice };
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
   * 현재 리스크 상태 조회
   */
  getStatus() {
    this.checkDailyReset();
    return {
      dailyPnL: this.dailyPnL,
      totalPnL: this.totalPnL,
      config: this.config,
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
