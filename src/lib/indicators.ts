// 기술적 지표 계산 라이브러리
// RSI, MACD, Bollinger Bands, SuperTrend, Moving Average 등

import { StockCandle } from './types';

export interface IndicatorResult {
  rsi: number[];
  macdLine: number[];
  macdSignal: number[];
  macdHistogram: number[];
  bbUpper: number[];
  bbMiddle: number[];
  bbLower: number[];
  superTrend: (number | null)[];
  superTrendDirection: ('UP' | 'DOWN')[];
  maShort: number[];
  maLong: number[];
  atr: number[];
}

/**
 * 단순 이동평균 (SMA)
 */
export function calculateSMA(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j];
    }
    result.push(sum / period);
  }
  return result;
}

/**
 * 지수 이동평균 (EMA)
 */
export function calculateEMA(data: number[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (period + 1);
  
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  const firstEMA = sum / period;
  
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
      continue;
    }
    if (i === period - 1) {
      result.push(firstEMA);
      continue;
    }
    const ema = (data[i] - result[i - 1]) * multiplier + result[i - 1];
    result.push(ema);
  }
  return result;
}

/**
 * RSI (상대강도지수)
 */
export function calculateRSI(closes: number[], period: number = 14): number[] {
  const result: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      result.push(NaN);
      continue;
    }

    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);

    if (i < period) {
      result.push(NaN);
      continue;
    }

    if (i === period) {
      const avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
      const avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
      
      if (avgLoss === 0) {
        result.push(100);
      } else {
        const rs = avgGain / avgLoss;
        result.push(100 - (100 / (1 + rs)));
      }
      continue;
    }

    // Smoothed RSI
    const prevRSI = result[i - 1];
    const prevAvgGain = (100 / (100 - prevRSI) - 1) * (gains.slice(Math.max(0, i - period), i).reduce((a, b) => a + b, 0) / period);
    const currentGain = gains[i - 1];
    const currentLoss = losses[i - 1];
    
    const avgGain = (prevAvgGain * (period - 1) + currentGain) / period;
    const avgLoss = ((prevAvgGain / ((100 / (100 - prevRSI)) - 1)) * (period - 1) + currentLoss) / period;

    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs = avgGain / avgLoss;
      result.push(100 - (100 / (1 + rs)));
    }
  }
  return result;
}

/**
 * RSI 계산 (간단 버전)
 */
export function calculateRSISimple(closes: number[], period: number = 14): number[] {
  const result: number[] = [];
  
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      result.push(NaN);
      continue;
    }
    
    let gainSum = 0;
    let lossSum = 0;
    
    for (let j = i - period + 1; j <= i; j++) {
      const change = closes[j] - closes[j - 1];
      if (change > 0) gainSum += change;
      else lossSum += Math.abs(change);
    }
    
    const avgGain = gainSum / period;
    const avgLoss = lossSum / period;
    
    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs = avgGain / avgLoss;
      result.push(100 - (100 / (1 + rs)));
    }
  }
  return result;
}

/**
 * MACD (이동평균수렴발산)
 */
export function calculateMACD(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const fastEMA = calculateEMA(closes, fastPeriod);
  const slowEMA = calculateEMA(closes, slowPeriod);
  
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(fastEMA[i]) || isNaN(slowEMA[i])) {
      macdLine.push(NaN);
    } else {
      macdLine.push(fastEMA[i] - slowEMA[i]);
    }
  }

  // MACD 라인의 EMA로 시그널 라인 계산
  const validMacd = macdLine.filter(v => !isNaN(v));
  const signalLine: number[] = [];
  let validIndex = 0;
  
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(macdLine[i])) {
      signalLine.push(NaN);
    } else {
      validIndex++;
      if (validIndex < signalPeriod) {
        signalLine.push(NaN);
      } else {
        const recentMacd = macdLine.slice(i - signalPeriod + 1, i + 1).filter(v => !isNaN(v));
        if (recentMacd.length < signalPeriod) {
          signalLine.push(NaN);
        } else {
          const multiplier = 2 / (signalPeriod + 1);
          if (signalLine.filter(v => !isNaN(v)).length === 0) {
            const sma = recentMacd.reduce((a, b) => a + b, 0) / signalPeriod;
            signalLine.push(sma);
          } else {
            const prevSignal = signalLine.filter(v => !isNaN(v)).pop()!;
            signalLine.push((macdLine[i] - prevSignal) * multiplier + prevSignal);
          }
        }
      }
    }
  }

  const histogram: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(macdLine[i]) || isNaN(signalLine[i])) {
      histogram.push(NaN);
    } else {
      histogram.push(macdLine[i] - signalLine[i]);
    }
  }

  return { macdLine, signalLine, histogram };
}

/**
 * Bollinger Bands (볼린저밴드)
 */
export function calculateBollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = calculateSMA(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (isNaN(middle[i])) {
      upper.push(NaN);
      lower.push(NaN);
      continue;
    }

    let sumSquaredDiff = 0;
    for (let j = 0; j < period; j++) {
      sumSquaredDiff += Math.pow(closes[i - j] - middle[i], 2);
    }
    const stdDev = Math.sqrt(sumSquaredDiff / period);
    
    upper.push(middle[i] + stdDevMultiplier * stdDev);
    lower.push(middle[i] - stdDevMultiplier * stdDev);
  }

  return { upper, middle, lower };
}

/**
 * ATR (Average True Range)
 */
export function calculateATR(candles: StockCandle[], period: number = 14): number[] {
  const trueRanges: number[] = [];
  const result: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trueRanges.push(candles[i].high - candles[i].low);
      result.push(NaN);
      continue;
    }

    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trueRanges.push(tr);

    if (i < period) {
      result.push(NaN);
      continue;
    }

    if (i === period) {
      const atr = trueRanges.slice(0, period + 1).reduce((a, b) => a + b, 0) / (period + 1);
      result.push(atr);
      continue;
    }

    const prevATR = result[i - 1];
    result.push((prevATR * (period - 1) + trueRanges[i]) / period);
  }

  return result;
}

/**
 * SuperTrend (슈퍼트렌드)
 */
export function calculateSuperTrend(
  candles: StockCandle[],
  atrPeriod: number = 10,
  multiplier: number = 3
): { values: (number | null)[]; directions: ('UP' | 'DOWN')[] } {
  const atr = calculateATR(candles, atrPeriod);
  const values: (number | null)[] = [];
  const directions: ('UP' | 'DOWN')[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (isNaN(atr[i])) {
      values.push(null);
      directions.push('UP');
      continue;
    }

    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpperBand = hl2 + multiplier * atr[i];
    const basicLowerBand = hl2 - multiplier * atr[i];

    if (i === 0 || values[i - 1] === null) {
      if (candles[i].close <= basicUpperBand) {
        values.push(basicUpperBand);
        directions.push('DOWN');
      } else {
        values.push(basicLowerBand);
        directions.push('UP');
      }
      continue;
    }

    const prevValue = values[i - 1]!;
    const prevDirection = directions[i - 1];

    let upperBand: number;
    let lowerBand: number;

    if (prevDirection === 'UP') {
      lowerBand = basicLowerBand > prevValue || candles[i - 1].close < prevValue 
        ? basicLowerBand 
        : prevValue;
      upperBand = basicUpperBand;
    } else {
      upperBand = basicUpperBand < prevValue || candles[i - 1].close > prevValue 
        ? basicUpperBand 
        : prevValue;
      lowerBand = basicLowerBand;
    }

    if (prevDirection === 'UP') {
      if (candles[i].close < lowerBand) {
        values.push(upperBand);
        directions.push('DOWN');
      } else {
        values.push(lowerBand);
        directions.push('UP');
      }
    } else {
      if (candles[i].close > upperBand) {
        values.push(lowerBand);
        directions.push('UP');
      } else {
        values.push(upperBand);
        directions.push('DOWN');
      }
    }
  }

  return { values, directions };
}

/**
 * 변동성 돌파 k값 계산 (래리 윌리엄스)
 */
export function calculateVolatilityBreakoutLevel(
  previousHigh: number,
  previousLow: number,
  previousClose: number,
  k: number = 0.5
): number {
  const range = previousHigh - previousLow;
  return previousClose + range * k;
}

/**
 * 거래량 이동평균
 */
export function calculateVolumeMA(volumes: number[], period: number = 20): number[] {
  return calculateSMA(volumes, period);
}

/**
 * 모든 지표 종합 계산
 */
export function calculateAllIndicators(
  candles: StockCandle[],
  params: {
    rsiPeriod?: number;
    macdFast?: number;
    macdSlow?: number;
    macdSignal?: number;
    bbPeriod?: number;
    bbStdDev?: number;
    atrPeriod?: number;
    atrMultiplier?: number;
    maShort?: number;
    maLong?: number;
  } = {}
): IndicatorResult {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const rsi = calculateRSISimple(closes, params.rsiPeriod || 14);
  const { macdLine, signalLine, histogram } = calculateMACD(
    closes,
    params.macdFast || 12,
    params.macdSlow || 26,
    params.macdSignal || 9
  );
  const { upper, middle, lower } = calculateBollingerBands(
    closes,
    params.bbPeriod || 20,
    params.bbStdDev || 2
  );
  const { values, directions } = calculateSuperTrend(
    candles,
    params.atrPeriod || 10,
    params.atrMultiplier || 3
  );
  const maShort = calculateSMA(closes, params.maShort || 5);
  const maLong = calculateSMA(closes, params.maLong || 20);
  const atr = calculateATR(candles, params.atrPeriod || 14);

  return {
    rsi,
    macdLine,
    macdSignal: signalLine,
    macdHistogram: histogram,
    bbUpper: upper,
    bbMiddle: middle,
    bbLower: lower,
    superTrend: values,
    superTrendDirection: directions,
    maShort,
    maLong,
    atr,
  };
}

/**
 * 마지막 유효값 가져오기
 */
export function getLastValidValue(arr: (number | null | undefined)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const val = arr[i];
    if (val !== null && val !== undefined && !isNaN(val)) {
      return val;
    }
  }
  return null;
}
