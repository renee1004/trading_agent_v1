// AI 매매전략 엔진
// 복합 지표 기반 최적 수익률 전략
// SuperTrend + MACD + RSI + Bollinger Bands + 이동평균선 조합
// 국내/해외 시장별 최적화 파라미터 자동 적용

import { StockCandle, TradingSignal, StrategyParameters, MarketType } from './types';
import {
  calculateAllIndicators,
  calculateVolatilityBreakoutLevel,
  getLastValidValue,
} from './indicators';
import { getMarketDefaults } from './market-defaults';

export class TradingEngine {
  /**
   * 시장별 최적화된 파라미터로 전략 분석 (진입점)
   * market 파라미터에 따라 자동으로 최적의 파라미터 적용
   * signalThreshold / weakSignalThreshold: strategyAggressiveness에 따른 동적 임계값
   */
  static analyze(
    candles: StockCandle[],
    stockCode: string,
    stockName: string,
    strategy: string = 'ALL',
    market: MarketType = 'DOMESTIC',
    userParams: StrategyParameters = {},
    signalThreshold: number = 60,
    weakSignalThreshold: number = 40,
  ): TradingSignal {
    // 시장별 기본 파라미터 가져오기
    const marketDefaults = getMarketDefaults(market);
    
    // 사용자 파라미터가 있으면 기본값 위에 오버라이드
    const params = { ...marketDefaults.strategy.composite, ...userParams };

    switch (strategy) {
      case 'COMPOSITE':
        return TradingEngine.analyzeComposite(candles, stockCode, stockName, params, market, signalThreshold, weakSignalThreshold);
      case 'VOLATILITY_BREAKOUT':
        return TradingEngine.analyzeVolatilityBreakout(candles, stockCode, stockName, params, market);
      case 'SUPER_TREND':
        return TradingEngine.analyzeSuperTrend(candles, stockCode, stockName, params, market);
      case 'MEAN_REVERSION':
        return TradingEngine.analyzeMeanReversion(candles, stockCode, stockName, params, market);
      case 'MOMENTUM':
        return TradingEngine.analyzeMomentum(candles, stockCode, stockName, params, market);
      case 'ALL':
      default:
        return TradingEngine.analyzeAllStrategies(candles, stockCode, stockName, params, market, signalThreshold, weakSignalThreshold);
    }
  }
  /**
   * === 전략 1: 복합 지표 전략 (COMPOSITE) ===
   * 수익률 높은 전략 - 2025년 트렌드 기반
   * SuperTrend + MACD + RSI + Bollinger Bands 4중 검증
   * 
   * 매수 조건 (모든 조건 충족 시):
   * 1. SuperTrend 방향 UP 전환
   * 2. MACD 히스토그램 양수 전환 (골든크로스)
   * 3. RSI가 과매도 구간(30) 이하에서 반등 또는 30-50 구간
   * 4. 종가가 볼린저밴드 중간선 이상
   * 5. 단기 이동평균선이 장기 이동평균선 돌파 (골든크로스)
   * 
   * 매도 조건:
   * 1. SuperTrend 방향 DOWN 전환
   * 2. MACD 히스토그램 음수 전환 (데드크로스)
   * 3. RSI가 과매수 구간(70) 이상
   * 4. 종가가 볼린저밴드 하단 이탈
   */
  static analyzeComposite(
    candles: StockCandle[],
    stockCode: string,
    stockName: string,
    params: StrategyParameters = {},
    market: MarketType = 'DOMESTIC',
    signalThreshold: number = 60,
    weakSignalThreshold: number = 40,
  ): TradingSignal {
    // 시장별 기본 파라미터 적용
    const marketDefaults = getMarketDefaults(market).strategy.composite;
    const effectiveParams = {
      rsiPeriod: params.rsiPeriod || marketDefaults.rsiPeriod,
      macdFast: params.macdFast || marketDefaults.macdFast,
      macdSlow: params.macdSlow || marketDefaults.macdSlow,
      macdSignal: params.macdSignal || marketDefaults.macdSignal,
      bbPeriod: params.bbPeriod || marketDefaults.bbPeriod,
      bbStdDev: params.bbStdDev || marketDefaults.bbStdDev,
      atrPeriod: params.atrPeriod || marketDefaults.atrPeriod,
      atrMultiplier: params.atrMultiplier || marketDefaults.atrMultiplier,
      maShort: params.maShort || marketDefaults.maShort,
      maLong: params.maLong || marketDefaults.maLong,
    };
    
    // 시장별 RSI 임계값
    const rsiOverbought = market === 'OVERSEAS' ? 75 : 70;
    const rsiOversold = market === 'OVERSEAS' ? 25 : 30;

    const indicators = calculateAllIndicators(candles, effectiveParams);

    const len = candles.length;
    if (len < 30) {
      return createHoldSignal(stockCode, stockName, candles, '데이터 부족');
    }

    const lastClose = candles[len - 1].close;
    const prevClose = candles[len - 2].close;

    // 각 지표 점수 계산
    let buyScore = 0;
    let sellScore = 0;
    const reasons: string[] = [];
    const indicatorValues: Record<string, number> = {};

    // 1. SuperTrend 분석
    const stDirection = indicators.superTrendDirection[len - 1];
    const prevStDirection = indicators.superTrendDirection[len - 2];
    
    if (stDirection === 'UP') {
      buyScore += 25;
      if (prevStDirection === 'DOWN') {
        buyScore += 10; // 전환 시 가산
        reasons.push('SuperTrend UP 전환');
      }
      indicatorValues['superTrend'] = 1;
    } else {
      sellScore += 25;
      if (prevStDirection === 'UP') {
        sellScore += 10;
        reasons.push('SuperTrend DOWN 전환');
      }
      indicatorValues['superTrend'] = -1;
    }

    // 2. MACD 분석
    const macdHist = indicators.macdHistogram[len - 1];
    const prevMacdHist = indicators.macdHistogram[len - 2];
    const macdLine = indicators.macdLine[len - 1];
    const macdSignal = indicators.macdSignal[len - 1];

    if (!isNaN(macdHist)) {
      indicatorValues['macdHist'] = macdHist;
      indicatorValues['macdLine'] = isNaN(macdLine) ? 0 : macdLine;
      indicatorValues['macdSignal'] = isNaN(macdSignal) ? 0 : macdSignal;

      if (macdHist > 0) {
        buyScore += 20;
        if (prevMacdHist <= 0 && !isNaN(prevMacdHist)) {
          buyScore += 10; // 골든크로스 가산
          reasons.push('MACD 골든크로스');
        }
      } else {
        sellScore += 20;
        if (prevMacdHist >= 0 && !isNaN(prevMacdHist)) {
          sellScore += 10; // 데드크로스 가산
          reasons.push('MACD 데드크로스');
        }
      }
    }

    // 3. RSI 분석 (시장별 임계값 적용)
    const rsi = indicators.rsi[len - 1];
    
    if (!isNaN(rsi)) {
      indicatorValues['rsi'] = rsi;
      
      if (rsi < rsiOversold) {
        buyScore += 25; // 과매도 구간
        reasons.push(`RSI 과매도(${rsi.toFixed(1)})`);
      } else if (rsi < 50) {
        buyScore += 15; // 반등 가능 구간
        if (rsi > 40) reasons.push(`RSI 반등(${rsi.toFixed(1)})`);
      } else if (rsi > rsiOverbought) {
        sellScore += 25; // 과매수 구간
        reasons.push(`RSI 과매수(${rsi.toFixed(1)})`);
      } else if (rsi > rsiOverbought - 10) {
        sellScore += 10;
      }
    }

    // 4. Bollinger Bands 분석
    const bbUpper = indicators.bbUpper[len - 1];
    const bbMiddle = indicators.bbMiddle[len - 1];
    const bbLower = indicators.bbLower[len - 1];

    if (!isNaN(bbUpper) && !isNaN(bbLower)) {
      const bbWidth = bbUpper - bbLower;
      indicatorValues['bbUpper'] = bbUpper;
      indicatorValues['bbMiddle'] = bbMiddle;
      indicatorValues['bbLower'] = bbLower;
      indicatorValues['bbWidth'] = bbWidth;

      if (lastClose > bbMiddle) {
        buyScore += 15;
        if (lastClose > bbUpper * 0.98) {
          sellScore += 10; // 상단 접근 시 익절
          reasons.push('BB 상단 접근');
        }
      }
      
      if (lastClose < bbLower) {
        sellScore += 20; // 하단 이탈
        reasons.push('BB 하단 이탈');
      }
      
      // 밴드폭 축소 후 돌파 (변동성 돌파)
      const prevBbWidth = indicators.bbUpper[len - 2] - indicators.bbLower[len - 2];
      if (!isNaN(prevBbWidth) && bbWidth < prevBbWidth * 0.9) {
        buyScore += 5;
        reasons.push('BB 밴드폭 축소');
      }
    }

    // 5. 이동평균선 분석
    const maShort = indicators.maShort[len - 1];
    const maLong = indicators.maLong[len - 1];
    const prevMaShort = indicators.maShort[len - 2];
    const prevMaLong = indicators.maLong[len - 2];

    if (!isNaN(maShort) && !isNaN(maLong)) {
      indicatorValues['maShort'] = maShort;
      indicatorValues['maLong'] = maLong;

      if (maShort > maLong) {
        buyScore += 15;
        if (!isNaN(prevMaShort) && !isNaN(prevMaLong) && prevMaShort <= prevMaLong) {
          buyScore += 10; // 골든크로스
          reasons.push('이평선 골든크로스');
        }
      } else {
        sellScore += 15;
        if (!isNaN(prevMaShort) && !isNaN(prevMaLong) && prevMaShort >= prevMaLong) {
          sellScore += 10; // 데드크로스
          reasons.push('이평선 데드크로스');
        }
      }

      // 가격이 이동평균선 위/아래
      if (lastClose > maShort && lastClose > maLong) {
        buyScore += 5;
      } else if (lastClose < maShort && lastClose < maLong) {
        sellScore += 5;
      }
    }

    // 신호 결정 (strategyAggressiveness 기반 동적 임계값)
    // 강한 신호: signalThreshold + 격차 15점 이상 우위
    // 약한 신호: weakSignalThreshold + 격차 5점 이상 우위
    const totalScore = Math.max(buyScore, sellScore);
    let signalType: 'BUY' | 'SELL' | 'HOLD';
    let confidence: number;
    let holdReason: string | undefined;

    if (buyScore >= signalThreshold && buyScore > sellScore + 15) {
      signalType = 'BUY';
      confidence = Math.min(95, buyScore);
    } else if (sellScore >= signalThreshold && sellScore > buyScore + 15) {
      signalType = 'SELL';
      confidence = Math.min(95, sellScore);
    } else if (buyScore > sellScore + 5 && buyScore >= weakSignalThreshold) {
      signalType = 'BUY';
      confidence = Math.min(70, buyScore);
    } else if (sellScore > buyScore + 5 && sellScore >= weakSignalThreshold) {
      signalType = 'SELL';
      confidence = Math.min(70, sellScore);
    } else {
      signalType = 'HOLD';
      confidence = Math.max(buyScore, sellScore);

      // holdReason 상세 진단
      if (buyScore > sellScore) {
        holdReason = `COMPOSITE 기준 미달: buyScore=${buyScore.toFixed(2)}, sellScore=${sellScore.toFixed(2)}, required=${signalThreshold}(강한), ${weakSignalThreshold}(약한), 격차=+${(buyScore - sellScore).toFixed(2)} (강한=15, 약한=5 필요)`;
      } else if (sellScore > buyScore) {
        holdReason = `COMPOSITE 기준 미달: sellScore=${sellScore.toFixed(2)}, buyScore=${buyScore.toFixed(2)}, required=${signalThreshold}(강한), ${weakSignalThreshold}(약한)`;
      } else {
        holdReason = `COMPOSITE 매수/매도 균형: buyScore=${buyScore.toFixed(2)} = sellScore=${sellScore.toFixed(2)}, 방향성 없음`;
      }
    }

    const reason = reasons.length > 0 
      ? reasons.join(' | ') 
      : signalType === 'HOLD' ? '명확한 신호 없음' : '복합 지표 신호';

    return {
      stockCode,
      stockName,
      signalType,
      strategy: 'COMPOSITE',
      confidence,
      price: lastClose,
      reason,
      holdReason,
      buyScore: Math.round(buyScore * 100) / 100,
      sellScore: Math.round(sellScore * 100) / 100,
      finalThreshold: signalThreshold,
      indicators: indicatorValues,
      timestamp: new Date(),
    };
  }

  /**
   * === 전략 2: 변동성 돌파 전략 (VOLATILITY_BREAKOUT) ===
   * 래리 윌리엄스의 변동성 돌파 전략
   * 전일 고가-저가 범위의 k배 이상 상승 시 매수
   * 
   * 장점: 한국 주식 시장에서 검증된 데이트레이딩 전략
   */
  static analyzeVolatilityBreakout(
    candles: StockCandle[],
    stockCode: string,
    stockName: string,
    params: StrategyParameters = {},
    market: MarketType = 'DOMESTIC'
  ): TradingSignal {
    // 시장별 k값: 국내 0.5 (표준), 해외 0.4 (보수적)
    const k = params.volatilityK || (market === 'OVERSEAS' ? 0.4 : 0.5);
    // 시장별 손절/익절: 해외는 더 넉넉하게
    const defaultStopLoss = market === 'OVERSEAS' ? 0.05 : 0.03;
    const len = candles.length;

    if (len < 3) {
      return createHoldSignal(stockCode, stockName, candles, '데이터 부족');
    }

    const todayOpen = candles[len - 1].open;
    const todayClose = candles[len - 1].close;
    const yesterdayHigh = candles[len - 2].high;
    const yesterdayLow = candles[len - 2].low;
    const yesterdayClose = candles[len - 2].close;

    const breakoutLevel = calculateVolatilityBreakoutLevel(
      yesterdayHigh,
      yesterdayLow,
      yesterdayClose,
      k
    );

    const indicatorValues: Record<string, number> = {
      breakoutLevel,
      yesterdayRange: yesterdayHigh - yesterdayLow,
      todayOpen,
    };

    // 추가 지표로 필터링
    const indicators = calculateAllIndicators(candles, {
      rsiPeriod: params.rsiPeriod || 14,
      maShort: 5,
      maLong: 20,
    });

    const rsi = getLastValidValue(indicators.rsi) || 50;
    const maShort = getLastValidValue(indicators.maShort) || todayClose;
    const maLong = getLastValidValue(indicators.maLong) || todayClose;

    indicatorValues['rsi'] = rsi;
    indicatorValues['maShort'] = maShort;
    indicatorValues['maLong'] = maLong;

    // 매수 조건
    if (todayClose > breakoutLevel && todayOpen < breakoutLevel) {
      // 돌파 발생 + 추가 필터
      let buyConfidence = 65;
      const reasons: string[] = [`변동성 돌파 (k=${k})`];

      if (rsi < 50) {
        buyConfidence += 10;
        reasons.push(`RSI 저위(${rsi.toFixed(1)})`);
      }
      if (maShort > maLong) {
        buyConfidence += 10;
        reasons.push('상승 추세');
      }
      if (todayClose > yesterdayHigh) {
        buyConfidence += 5;
        reasons.push('전일 고가 돌파');
      }

      return {
        stockCode,
        stockName,
        signalType: 'BUY',
        strategy: 'VOLATILITY_BREAKOUT',
        confidence: Math.min(95, buyConfidence),
        price: todayClose,
        reason: reasons.join(' | '),
        indicators: indicatorValues,
        timestamp: new Date(),
      };
    }

    // 매도 조건 (보유 중인 경우) - 시장별 손절 폭 적용
    if (todayClose < yesterdayClose * (1 - (params.stopLoss || defaultStopLoss))) {
      return {
        stockCode,
        stockName,
        signalType: 'SELL',
        strategy: 'VOLATILITY_BREAKOUT',
        confidence: 75,
        price: todayClose,
        reason: '손절가 이탈',
        indicators: indicatorValues,
        timestamp: new Date(),
      };
    }

    return {
      stockCode,
      stockName,
      signalType: 'HOLD',
      strategy: 'VOLATILITY_BREAKOUT',
      confidence: 30,
      price: todayClose,
      reason: `돌파가 미달 (현재:${todayClose}, 돌파가:${breakoutLevel.toFixed(0)})`,
      indicators: indicatorValues,
      timestamp: new Date(),
    };
  }

  /**
   * === 전략 3: SuperTrend 추세 추종 전략 ===
   * 백테스트 153-299% 수익률 검증 전략
   * SuperTrend + MACD + RSI 3중 검증
   */
  static analyzeSuperTrend(
    candles: StockCandle[],
    stockCode: string,
    stockName: string,
    params: StrategyParameters = {},
    market: MarketType = 'DOMESTIC'
  ): TradingSignal {
    // 시장별 SuperTrend 파라미터: 해외는 더 긴 주기 + 더 큰 승수
    const stDefaults = getMarketDefaults(market).strategy.superTrend;
    const indicators = calculateAllIndicators(candles, {
      atrPeriod: params.atrPeriod || stDefaults.atrPeriod,
      atrMultiplier: params.atrMultiplier || stDefaults.atrMultiplier,
      rsiPeriod: params.rsiPeriod || stDefaults.rsiPeriod,
      macdFast: params.macdFast || stDefaults.macdFast,
      macdSlow: params.macdSlow || stDefaults.macdSlow,
      macdSignal: params.macdSignal || stDefaults.macdSignal,
    });

    const len = candles.length;
    if (len < 30) {
      return createHoldSignal(stockCode, stockName, candles, '데이터 부족');
    }

    const lastClose = candles[len - 1].close;
    const stDirection = indicators.superTrendDirection[len - 1];
    const prevStDirection = indicators.superTrendDirection[len - 2];
    const rsi = indicators.rsi[len - 1];
    const macdHist = indicators.macdHistogram[len - 1];
    const prevMacdHist = indicators.macdHistogram[len - 2];

    const indicatorValues: Record<string, number> = {};
    const stValue = indicators.superTrend[len - 1];
    if (stValue !== null) indicatorValues['superTrend'] = stValue;
    if (!isNaN(rsi)) indicatorValues['rsi'] = rsi;
    if (!isNaN(macdHist)) indicatorValues['macdHist'] = macdHist;

    const reasons: string[] = [];

    // SuperTrend 전환 감지
    if (stDirection === 'UP' && prevStDirection === 'DOWN') {
      let confidence = 60;
      reasons.push('SuperTrend UP 전환');

      // MACD 확인
      if (!isNaN(macdHist) && macdHist > 0) {
        confidence += 15;
        reasons.push('MACD 양수 확인');
      }
      if (!isNaN(prevMacdHist) && prevMacdHist <= 0 && macdHist > 0) {
        confidence += 10;
        reasons.push('MACD 골든크로스');
      }

      // RSI 확인 (과매도 반등이 최고)
      if (!isNaN(rsi) && rsi < 50) {
        confidence += 10;
        reasons.push(`RSI ${rsi.toFixed(1)}`);
      }

      return {
        stockCode,
        stockName,
        signalType: 'BUY',
        strategy: 'SUPER_TREND',
        confidence: Math.min(95, confidence),
        price: lastClose,
        reason: reasons.join(' | '),
        indicators: indicatorValues,
        timestamp: new Date(),
      };
    }

    if (stDirection === 'DOWN' && prevStDirection === 'UP') {
      let confidence = 60;
      reasons.push('SuperTrend DOWN 전환');

      if (!isNaN(macdHist) && macdHist < 0) {
        confidence += 15;
        reasons.push('MACD 음수 확인');
      }
      if (!isNaN(rsi) && rsi > 50) {
        confidence += 10;
        reasons.push(`RSI ${rsi.toFixed(1)}`);
      }

      return {
        stockCode,
        stockName,
        signalType: 'SELL',
        strategy: 'SUPER_TREND',
        confidence: Math.min(95, confidence),
        price: lastClose,
        reason: reasons.join(' | '),
        indicators: indicatorValues,
        timestamp: new Date(),
      };
    }

    // 추세 유지 중
    return {
      stockCode,
      stockName,
      signalType: 'HOLD',
      strategy: 'SUPER_TREND',
      confidence: 40,
      price: lastClose,
      reason: `SuperTrend ${stDirection} 유지 중`,
      indicators: indicatorValues,
      timestamp: new Date(),
    };
  }

  /**
   * === 전략 4: 평균 회귀 전략 (MEAN_REVERSION) ===
   * 볼린저밴드 하단 매수 / 상단 매도
   * RSI 과매도/과매수 활용
   */
  static analyzeMeanReversion(
    candles: StockCandle[],
    stockCode: string,
    stockName: string,
    params: StrategyParameters = {},
    market: MarketType = 'DOMESTIC'
  ): TradingSignal {
    // 시장별 평균 회귀 파라미터
    const mrDefaults = getMarketDefaults(market).strategy.meanReversion;
    const rsiOverbought = mrDefaults.rsiOverbought;
    const rsiOversold = mrDefaults.rsiOversold;
    const indicators = calculateAllIndicators(candles, {
      bbPeriod: params.bbPeriod || mrDefaults.bbPeriod,
      bbStdDev: params.bbStdDev || mrDefaults.bbStdDev,
      rsiPeriod: params.rsiPeriod || mrDefaults.rsiPeriod,
    });

    const len = candles.length;
    if (len < 30) {
      return createHoldSignal(stockCode, stockName, candles, '데이터 부족');
    }

    const lastClose = candles[len - 1].close;
    const bbUpper = indicators.bbUpper[len - 1];
    const bbLower = indicators.bbLower[len - 1];
    const bbMiddle = indicators.bbMiddle[len - 1];
    const rsi = indicators.rsi[len - 1];
    const prevRsi = indicators.rsi[len - 2];

    const indicatorValues: Record<string, number> = {};
    if (!isNaN(bbUpper)) indicatorValues['bbUpper'] = bbUpper;
    if (!isNaN(bbLower)) indicatorValues['bbLower'] = bbLower;
    if (!isNaN(bbMiddle)) indicatorValues['bbMiddle'] = bbMiddle;
    if (!isNaN(rsi)) indicatorValues['rsi'] = rsi;

    const reasons: string[] = [];

    // 매수: 하단 터치 + RSI 과매도 반등 (시장별 임계값)
    if (!isNaN(bbLower) && lastClose <= bbLower * 1.01) {
      let confidence = 55;
      reasons.push('BB 하단 터치');

      if (!isNaN(rsi) && rsi < rsiOversold) {
        confidence += 20;
        reasons.push(`RSI 과매도(${rsi.toFixed(1)})`);
      }
      if (!isNaN(rsi) && !isNaN(prevRsi) && rsi > prevRsi && rsi < rsiOversold + 10) {
        confidence += 10;
        reasons.push('RSI 반등 시작');
      }

      return {
        stockCode,
        stockName,
        signalType: 'BUY',
        strategy: 'MEAN_REVERSION',
        confidence: Math.min(90, confidence),
        price: lastClose,
        reason: reasons.join(' | '),
        indicators: indicatorValues,
        timestamp: new Date(),
      };
    }

    // 매도: 상단 터치 + RSI 과매수 (시장별 임계값)
    if (!isNaN(bbUpper) && lastClose >= bbUpper * 0.99) {
      let confidence = 55;
      reasons.push('BB 상단 터치');

      if (!isNaN(rsi) && rsi > rsiOverbought) {
        confidence += 20;
        reasons.push(`RSI 과매수(${rsi.toFixed(1)})`);
      }

      return {
        stockCode,
        stockName,
        signalType: 'SELL',
        strategy: 'MEAN_REVERSION',
        confidence: Math.min(90, confidence),
        price: lastClose,
        reason: reasons.join(' | '),
        indicators: indicatorValues,
        timestamp: new Date(),
      };
    }

    return {
      stockCode,
      stockName,
      signalType: 'HOLD',
      strategy: 'MEAN_REVERSION',
      confidence: 25,
      price: lastClose,
      reason: '밴드 중간대 위치',
      indicators: indicatorValues,
      timestamp: new Date(),
    };
  }

  /**
   * === 전략 5: 모멘텀 전략 (MOMENTUM) ===
   * 거래량 폭증 + 가격 상승 모멘텀 포착
   * 세력 매집 패턴 감지
   */
  static analyzeMomentum(
    candles: StockCandle[],
    stockCode: string,
    stockName: string,
    params: StrategyParameters = {},
    market: MarketType = 'DOMESTIC'
  ): TradingSignal {
    // 시장별 모멘텀 파라미터
    const momDefaults = getMarketDefaults(market).strategy.momentum;
    const volumeSpikeThreshold = momDefaults.volumeSpikeThreshold;
    const minConsecutiveDays = momDefaults.minConsecutiveDays;
    const indicators = calculateAllIndicators(candles, {
      rsiPeriod: params.rsiPeriod || momDefaults.rsiPeriod,
      maShort: params.maShort || momDefaults.maShort,
      maLong: params.maLong || momDefaults.maLong,
    });

    const len = candles.length;
    if (len < 25) {
      return createHoldSignal(stockCode, stockName, candles, '데이터 부족');
    }

    const lastClose = candles[len - 1].close;
    const lastVolume = candles[len - 1].volume;
    
    // 거래량 평균 (20일)
    const recentVolumes = candles.slice(-20).map(c => c.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const volumeRatio = lastVolume / avgVolume;

    const rsi = indicators.rsi[len - 1];
    const maShort = indicators.maShort[len - 1];
    const maLong = indicators.maLong[len - 1];

    const indicatorValues: Record<string, number> = {
      volumeRatio,
      avgVolume,
      lastVolume,
    };
    if (!isNaN(rsi)) indicatorValues['rsi'] = rsi;
    if (!isNaN(maShort)) indicatorValues['maShort'] = maShort;
    if (!isNaN(maLong)) indicatorValues['maLong'] = maLong;

    const reasons: string[] = [];

    // 거래량 폭증 + 가격 상승 = 세력 매집 가능성 (시장별 임계값)
    if (volumeRatio > volumeSpikeThreshold && lastClose > candles[len - 2].close) {
      let confidence = 60;
      reasons.push(`거래량 폭증 (${volumeRatio.toFixed(1)}배)`);

      if (!isNaN(rsi) && rsi < 60) {
        confidence += 10;
        reasons.push(`RSI ${rsi.toFixed(1)}`);
      }
      if (!isNaN(maShort) && !isNaN(maLong) && maShort > maLong) {
        confidence += 10;
        reasons.push('상승 추세');
      }

      // 연속 상승일 확인 (시장별 최소 일수)
      const recentCloses = candles.slice(-minConsecutiveDays - 1).map(c => c.close);
      if (recentCloses.length >= minConsecutiveDays && recentCloses.every((c, i) => i === 0 || c > recentCloses[i - 1])) {
        confidence += 5;
        reasons.push('연속 상승');
      }

      return {
        stockCode,
        stockName,
        signalType: 'BUY',
        strategy: 'MOMENTUM',
        confidence: Math.min(90, confidence),
        price: lastClose,
        reason: reasons.join(' | '),
        indicators: indicatorValues,
        timestamp: new Date(),
      };
    }

    // 거래량 감소 + 하락 = 매도 신호 (해외는 임계값 다름)
    const volumeLowThreshold = market === 'OVERSEAS' ? 0.6 : 0.5;
    if (volumeRatio < volumeLowThreshold && lastClose < candles[len - 2].close) {
      return {
        stockCode,
        stockName,
        signalType: 'SELL',
        strategy: 'MOMENTUM',
        confidence: 55,
        price: lastClose,
        reason: `거래량 감소(${volumeRatio.toFixed(1)}배) + 하락`,
        indicators: indicatorValues,
        timestamp: new Date(),
      };
    }

    return {
      stockCode,
      stockName,
      signalType: 'HOLD',
      strategy: 'MOMENTUM',
      confidence: 20,
      price: lastClose,
      reason: `거래량 비율: ${volumeRatio.toFixed(1)}배`,
      indicators: indicatorValues,
      timestamp: new Date(),
    };
  }

  /**
   * 모든 전략 종합 분석 (AI 에이전트 핵심)
   * 각 전략의 신호를 가중 평균하여 최종 신호 도출
   */
  static analyzeAllStrategies(
    candles: StockCandle[],
    stockCode: string,
    stockName: string,
    params: StrategyParameters = {},
    market: MarketType = 'DOMESTIC',
    signalThreshold: number = 60,
    weakSignalThreshold: number = 40,
  ): TradingSignal {
    // 각 전략별 분석 (시장별 파라미터 자동 적용)
    const composite = TradingEngine.analyzeComposite(candles, stockCode, stockName, params, market, signalThreshold, weakSignalThreshold);
    const volatility = TradingEngine.analyzeVolatilityBreakout(candles, stockCode, stockName, params, market);
    const superTrend = TradingEngine.analyzeSuperTrend(candles, stockCode, stockName, params, market);
    const meanReversion = TradingEngine.analyzeMeanReversion(candles, stockCode, stockName, params, market);
    const momentum = TradingEngine.analyzeMomentum(candles, stockCode, stockName, params, market);

    const signals = [composite, volatility, superTrend, meanReversion, momentum];
    
    // 시장별 전략 가중치 (리서치 기반)
    // 국내: 변동성돌파 가중치 높음 | 해외: SuperTrend 가중치 높음
    const weights = getMarketDefaults(market).strategy.strategyWeights;

    let buyScore = 0;
    let sellScore = 0;
    let totalWeight = 0;
    const strategyResults: string[] = [];

    for (const signal of signals) {
      const weight = weights[signal.strategy] || 0.1;
      totalWeight += weight;

      if (signal.signalType === 'BUY') {
        buyScore += weight * signal.confidence;
      } else if (signal.signalType === 'SELL') {
        sellScore += weight * signal.confidence;
      }

      strategyResults.push(`${signal.strategy}:${signal.signalType}(${signal.confidence})`);
    }

    buyScore /= totalWeight;
    sellScore /= totalWeight;

    // 최종 신호 결정 (strategyAggressiveness 기반 동적 임계값 적용)
    // 강한 신호: signalThreshold 이상 + 격차 조건 충족
    // 약한 신호: weakSignalThreshold 이상 + 단순 우위
    let signalType: 'BUY' | 'SELL' | 'HOLD';
    let confidence: number;
    let reason: string;
    let holdReason: string | undefined;

    if (buyScore >= signalThreshold && buyScore > sellScore + 15) {
      // 강한 BUY: signalThreshold 도달 + sellScore 대비 15점 이상 우위
      signalType = 'BUY';
      confidence = Math.min(95, buyScore);
      reason = `종합 강한 매수신호 (buyScore=${buyScore.toFixed(2)} >= ${signalThreshold}) [${strategyResults.join(', ')}]`;
    } else if (sellScore >= signalThreshold && sellScore > buyScore + 15) {
      // 강한 SELL: signalThreshold 도달 + buyScore 대비 15점 이상 우위
      signalType = 'SELL';
      confidence = Math.min(95, sellScore);
      reason = `종합 강한 매도신호 (sellScore=${sellScore.toFixed(2)} >= ${signalThreshold}) [${strategyResults.join(', ')}]`;
    } else if (buyScore > sellScore && buyScore >= weakSignalThreshold) {
      // 약한 BUY: weakSignalThreshold 도달 + sellScore 대비 단순 우위
      signalType = 'BUY';
      confidence = Math.min(70, buyScore);
      reason = `종합 약한 매수신호 (buyScore=${buyScore.toFixed(2)} >= weak=${weakSignalThreshold}) [${strategyResults.join(', ')}]`;
    } else if (sellScore > buyScore && sellScore >= weakSignalThreshold) {
      // 약한 SELL: weakSignalThreshold 도달 + buyScore 대비 단순 우위
      signalType = 'SELL';
      confidence = Math.min(70, sellScore);
      reason = `종합 약한 매도신호 (sellScore=${sellScore.toFixed(2)} >= weak=${weakSignalThreshold}) [${strategyResults.join(', ')}]`;
    } else {
      // HOLD: 어떤 임계값도 충족하지 못함
      signalType = 'HOLD';
      confidence = Math.max(buyScore, sellScore);

      // holdReason 상세 진단
      if (buyScore > sellScore) {
        holdReason = `ALL 최종 기준 미달: buyScore=${buyScore.toFixed(2)}, sellScore=${sellScore.toFixed(2)}, required=${signalThreshold}(강한), ${weakSignalThreshold}(약한)`;
        if (buyScore >= signalThreshold - 10) {
          holdReason += ` | ${signalThreshold - buyScore < 0 ? '' : 'signalThreshold까지만 ' + (signalThreshold - buyScore).toFixed(2) + '점'}`;
        }
      } else if (sellScore > buyScore) {
        holdReason = `ALL 최종 기준 미달: sellScore=${sellScore.toFixed(2)}, buyScore=${buyScore.toFixed(2)}, required=${signalThreshold}(강한), ${weakSignalThreshold}(약한)`;
      } else {
        holdReason = `ALL 매수/매도 균형: buyScore=${buyScore.toFixed(2)} = sellScore=${sellScore.toFixed(2)}, 뚜렷한 방향성 없음`;
      }
      reason = holdReason;
    }

    // 모든 지표 합산
    const allIndicators: Record<string, number> = {};
    for (const signal of signals) {
      Object.entries(signal.indicators).forEach(([key, value]) => {
        if (!(key in allIndicators)) {
          allIndicators[key] = value;
        }
      });
    }

    return {
      stockCode,
      stockName,
      signalType,
      strategy: 'ALL',
      confidence,
      price: candles[candles.length - 1].close,
      reason,
      holdReason,
      buyScore: Math.round(buyScore * 100) / 100,
      sellScore: Math.round(sellScore * 100) / 100,
      finalThreshold: signalThreshold,
      indicators: allIndicators,
      timestamp: new Date(),
    };
  }
}

function createHoldSignal(
  stockCode: string, 
  stockName: string, 
  candles: StockCandle[], 
  reason: string
): TradingSignal {
  return {
    stockCode,
    stockName,
    signalType: 'HOLD',
    strategy: 'UNKNOWN',
    confidence: 0,
    price: candles.length > 0 ? candles[candles.length - 1].close : 0,
    reason,
    indicators: {},
    timestamp: new Date(),
  };
}
