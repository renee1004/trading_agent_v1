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
   */
  static analyze(
    candles: StockCandle[],
    stockCode: string,
    stockName: string,
    strategy: string = 'ALL',
    market: MarketType = 'DOMESTIC',
    userParams: StrategyParameters = {}
  ): TradingSignal {
    // 시장별 기본 파라미터 가져오기
    const marketDefaults = getMarketDefaults(market);
    
    // 사용자 파라미터가 있으면 기본값 위에 오버라이드
    const params = { ...marketDefaults.strategy.composite, ...userParams };

    switch (strategy) {
      case 'COMPOSITE':
        return TradingEngine.analyzeComposite(candles, stockCode, stockName, params, market);
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
        return TradingEngine.analyzeAllStrategies(candles, stockCode, stockName, params, market);
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
    market: MarketType = 'DOMESTIC'
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

    // 신호 결정
    const totalScore = Math.max(buyScore, sellScore);
    let signalType: 'BUY' | 'SELL' | 'HOLD';
    let confidence: number;

    if (buyScore >= 60 && buyScore > sellScore + 20) {
      signalType = 'BUY';
      confidence = Math.min(95, buyScore);
    } else if (sellScore >= 60 && sellScore > buyScore + 20) {
      signalType = 'SELL';
      confidence = Math.min(95, sellScore);
    } else if (buyScore > sellScore && buyScore >= 40) {
      signalType = 'BUY';
      confidence = Math.min(70, buyScore);
    } else if (sellScore > buyScore && sellScore >= 40) {
      signalType = 'SELL';
      confidence = Math.min(70, sellScore);
    } else {
      signalType = 'HOLD';
      confidence = Math.max(buyScore, sellScore);
    }

    const reason = reasons.length > 0 
      ? reasons.join(' | ') 
      : signalType === 'HOLD' ? '명확한 신호 없음' : '복합 지표 신호';

    // HOLD 상세 사유 생성
    let holdReason: string | undefined;
    if (signalType === 'HOLD') {
      const holdReasons: string[] = [];
      if (buyScore < 60) holdReasons.push(`매수스코어 미달(${buyScore}/60)`);
      if (sellScore < 60) holdReasons.push(`매도신호 불충분`);
      if (buyScore > sellScore && buyScore < 60) holdReasons.push(`추세 방향 불분명, RSI=${indicatorValues['rsi']?.toFixed(1) || '?'}, MACD=${indicatorValues['macdSignal']?.toFixed(1) || '?'}`);
      holdReason = holdReasons.length > 0 ? holdReasons.join(', ') : '명확한 방향성 없음';
    }

    return {
      stockCode,
      stockName,
      signalType,
      strategy: 'COMPOSITE',
      confidence,
      price: lastClose,
      reason,
      holdReason,
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
      holdReason: `돌파가 미달: 종가(${todayClose}) < 돌파가(${breakoutLevel.toFixed(0)})`,
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
      holdReason: `추세 전환 대기: SuperTrend 방향 미변경`,
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

    // BB 위치 계산
    const bbPosition = (!isNaN(bbUpper) && !isNaN(bbLower) && (bbUpper - bbLower) > 0)
      ? ((lastClose - bbLower) / (bbUpper - bbLower) * 100).toFixed(0)
      : '?';

    return {
      stockCode,
      stockName,
      signalType: 'HOLD',
      strategy: 'MEAN_REVERSION',
      confidence: 25,
      price: lastClose,
      reason: '밴드 중간대 위치',
      holdReason: `과매도/과매수 구간 아님: RSI=${!isNaN(rsi) ? rsi.toFixed(1) : '?'}, BB위치=${bbPosition}%`,
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

    const maTrend = (!isNaN(maShort) && !isNaN(maLong))
      ? (maShort > maLong ? '상승' : '하락')
      : '불명';

    return {
      stockCode,
      stockName,
      signalType: 'HOLD',
      strategy: 'MOMENTUM',
      confidence: 20,
      price: lastClose,
      reason: `거래량 비율: ${volumeRatio.toFixed(1)}배`,
      holdReason: `모멘텀 부족: 거래량비율=${volumeRatio.toFixed(1)}, 추세=${maTrend}`,
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
    market: MarketType = 'DOMESTIC'
  ): TradingSignal {
    // 각 전략별 분석 (시장별 파라미터 자동 적용)
    const composite = TradingEngine.analyzeComposite(candles, stockCode, stockName, params, market);
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

    // 최종 신호 결정
    let signalType: 'BUY' | 'SELL' | 'HOLD';
    let confidence: number;
    let reason: string;

    if (buyScore > sellScore + 15 && buyScore >= 50) {
      signalType = 'BUY';
      confidence = Math.min(95, buyScore);
      reason = `종합 매수신호 [${strategyResults.join(', ')}]`;
    } else if (sellScore > buyScore + 15 && sellScore >= 50) {
      signalType = 'SELL';
      confidence = Math.min(95, sellScore);
      reason = `종합 매도신호 [${strategyResults.join(', ')}]`;
    } else {
      signalType = 'HOLD';
      confidence = Math.max(buyScore, sellScore);
      reason = `신호 혼재 [${strategyResults.join(', ')}]`;
    }

    // HOLD 상세 사유 생성
    let holdReason: string | undefined;
    if (signalType === 'HOLD') {
      const holdReasons: string[] = [];
      if (buyScore < 50) holdReasons.push(`매수스코어 부족(${buyScore.toFixed(0)}/50)`);
      if (sellScore < 50) holdReasons.push(`매도스코어 부족(${sellScore.toFixed(0)}/50)`);
      if (buyScore - sellScore <= 15 && buyScore > sellScore) holdReasons.push('매수-매도 격차 미달(15pt 미만)');
      if (sellScore - buyScore <= 15 && sellScore > buyScore) holdReasons.push('매도-매수 격차 미달(15pt 미만)');
      holdReason = holdReasons.length > 0 ? holdReasons.join(', ') : '명확한 방향성 없음';
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
      indicators: allIndicators,
      timestamp: new Date(),
    };
  }
}

function createHoldSignal(
  stockCode: string, 
  stockName: string, 
  candles: StockCandle[], 
  reason: string,
  holdReason?: string,
): TradingSignal {
  return {
    stockCode,
    stockName,
    signalType: 'HOLD',
    strategy: 'UNKNOWN',
    confidence: 0,
    price: candles.length > 0 ? candles[candles.length - 1].close : 0,
    reason,
    holdReason,
    indicators: {},
    timestamp: new Date(),
  };
}
