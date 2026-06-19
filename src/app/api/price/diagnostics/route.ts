// GET /api/price/diagnostics?code=005930
// 가격 파싱 진단 API — KIS 원본 응답과 파싱 결과 비교
//
// 사용자 신고 케이스 해결:
//   삼성전자 005930 신호 price = 370,750원 (비정상)
//   KIS 현재가 = 70,100원 (정상)
//   괴리율 = 428.7%
//
// 원인 진단:
//   1) KIS 일봉 API의 FID_ORG_ADJ_PRC=1 (원주가) 응답이 액면분할 전 가격을 반환
//   2) stck_clpr 필드 파싱 시 단위 보정 누락
//   3) 수정주가/원주가 혼용
//
// 응답:
//   {
//     stockCode, stockName,
//     currentPriceRaw: { ... KIS inquire-price raw response },
//     candleRaw: { recent3: [... KIS inquire-daily-itemchartprice 최근 3개 raw] },
//     parsed: {
//       currentPrice: number,       // getStockPrice 파싱 결과
//       candleClose: number,        // 마지막 일봉 close (signal.price = 이 값)
//       candleOpen, candleHigh, candleLow,
//       candleDate: string,
//     },
//     final: {
//       signalPrice: number,        // 신호.price (캔들 lastClose)
//       lastClose: number,          // parsed.candleClose와 동일
//       currentPrice: number,       // parsed.currentPrice
//     },
//     normalizationApplied: boolean,  // 코드 정규화 여부 (KRX:005930 → 005930)
//     multiplierApplied: number | null, // 배율 보정값 (파싱 과정에서 적용된 배율)
//     priceSource: 'KIS_REST_PRICE' | 'KIS_DAILY_CANDLE_CLOSE',
//     anomalyReason: string,         // anomaly 사유 (괴리 20% 이상 시)
//     priceAnomaly: boolean,         // 20% 괴리 여부
//     gapPercent: number,            // |signalPrice - currentPrice| / min(signalPrice, currentPrice)
//     recommendation: string,
//   }

import { NextRequest, NextResponse } from 'next/server';
import { KisApiClient } from '@/lib/kis-api';
import { getOrCreateKisConfigFromEnv } from '@/lib/kis-config-loader';
import { normalizeStockCode } from '@/lib/stock-master';
import { checkPriceAnomaly, PRICE_ANOMALY_THRESHOLD } from '@/lib/price-anomaly';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const stockCode = searchParams.get('code');

    if (!stockCode) {
      return NextResponse.json(
        {
          success: false,
          error: 'code 파라미터 필요 (예: /api/price/diagnostics?code=005930)',
        },
        { status: 400 }
      );
    }

    const normalizedCode = normalizeStockCode(stockCode);
    const normalizationApplied = normalizedCode !== stockCode;

    const config = await getOrCreateKisConfigFromEnv();
    if (!config) {
      return NextResponse.json(
        {
          success: false,
          error: 'KIS 설정 없음 — KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NO 환경변수 필요',
          stockCode,
          normalizedCode,
        },
        { status: 503 }
      );
    }

    const client = new KisApiClient({
      appKey: config.appKey,
      appSecret: config.appSecret,
      accountNo: config.accountNo,
      isDemo: config.isDemo,
      accessToken: config.accessToken || undefined,
      tokenExpiresAt: config.tokenExpiresAt ?? undefined,
    });

    // ── 1) KIS inquire-price 원본 응답 (raw) ──
    // getStockPrice()는 파싱 후 반환하므로, 원본을 별도로 fetch
    let currentPriceRaw: any = null;
    let currentPriceRawError: string | null = null;
    let parsedCurrentPrice = 0;
    let stockName = stockCode;
    try {
      const token = await (client as any).ensureToken();
      const baseUrl = config.isDemo
        ? 'https://openapivts.koreainvestment.com:29443'
        : 'https://openapi.koreainvestment.com:9443';
      const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price`;
      const params = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: normalizedCode,
      });
      const response = await fetch(`${url}?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appKey: config.appKey,
          appSecret: config.appSecret,
          tr_id: 'FHKST01010100',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      currentPriceRaw = await response.json();
      const output = currentPriceRaw?.output;
      if (output) {
        stockName = output.hts_kor_isnm || stockCode;
        parsedCurrentPrice = parseInt(output.stck_prpr) || 0;
      }
    } catch (e) {
      currentPriceRawError = e instanceof Error ? e.message : String(e);
    }

    // ── 2) KIS 일봉 원본 응답 (raw) — 최근 3개만 ──
    let candleRaw: any = null;
    let candleRawError: string | null = null;
    let candleRawRecent3: any[] = [];
    let parsedCandleClose = 0;
    let parsedCandleOpen = 0;
    let parsedCandleHigh = 0;
    let parsedCandleLow = 0;
    let parsedCandleDate = '';
    try {
      const token = await (client as any).ensureToken();
      const baseUrl = config.isDemo
        ? 'https://openapivts.koreainvestment.com:29443'
        : 'https://openapi.koreainvestment.com:9443';
      const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`;

      // 최근 1개월치 조회 후 최근 3개만 추출
      const endDateObj = new Date();
      const startDateObj = new Date();
      startDateObj.setMonth(startDateObj.getMonth() - 1);
      const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');
      const endDate = endDateObj.toISOString().slice(0, 10).replace(/-/g, '');

      const params = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: normalizedCode,
        FID_INPUT_DATE_1: startDate,
        FID_INPUT_DATE_2: endDate,
        FID_PERIOD_DIV_CODE: 'D',
        FID_ORG_ADJ_PRC: '1', // 원주가 — getStockDailyCandles와 동일
      });

      const response = await fetch(`${url}?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appKey: config.appKey,
          appSecret: config.appSecret,
          tr_id: 'FHKST03010100',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      candleRaw = await response.json();
      const output2 = Array.isArray(candleRaw?.output2) ? candleRaw.output2 : [];
      // KIS는 최신일이 output2[0]에 옴 — 역순 정렬하여 최신이 마지막으로
      // getStockDailyCandles는 .reverse()를 호출하므로 파싱 로직과 동일하게
      const reversed = [...output2].reverse();
      candleRawRecent3 = reversed.slice(-3);
      const lastCandle = candleRawRecent3[candleRawRecent3.length - 1];
      if (lastCandle) {
        parsedCandleClose = parseInt(lastCandle.stck_clpr) || 0;
        parsedCandleOpen = parseInt(lastCandle.stck_oprc) || 0;
        parsedCandleHigh = parseInt(lastCandle.stck_hgpr) || 0;
        parsedCandleLow = parseInt(lastCandle.stck_lwpr) || 0;
        parsedCandleDate = lastCandle.stck_bsop_date || '';
      }
    } catch (e) {
      candleRawError = e instanceof Error ? e.message : String(e);
    }

    // ── 3) anomaly 검증 ──
    const anomalyResult = checkPriceAnomaly(
      parsedCandleClose, // 분석 기준가 (signal.price = 캔들 close)
      parsedCurrentPrice, // KIS 실시간 현재가
      stockCode,
      stockName,
    );

    // ── 4) 배율 추정 ──
    // parsedCandleClose / parsedCurrentPrice 비율로 액면분할 배율 추정
    // 1.0에 가까우면 정상, 5.0이면 5배 (예: 1주→5주 분할 후 원주가로 조회)
    let multiplierApplied: number | null = null;
    let multiplierReason = '';
    if (parsedCandleClose > 0 && parsedCurrentPrice > 0) {
      const ratio = parsedCandleClose / parsedCurrentPrice;
      multiplierApplied = parseFloat(ratio.toFixed(4));
      // 일반적인 괴리가 아니라 정확히 N배라면 분할/합병 가능성
      const knownMultipliers = [0.2, 0.25, 0.5, 2, 3, 5, 10, 25, 50];
      for (const m of knownMultipliers) {
        if (Math.abs(ratio - m) / m < 0.02) {
          multiplierReason = `정확히 ${m}배 괴리 → 액면분할/합병 가능성 (FID_ORG_ADJ_PRC=1 원주가 응답)`;
          break;
        }
      }
      if (!multiplierReason && Math.abs(ratio - 1.0) > 0.20) {
        multiplierReason = `${ratio.toFixed(2)}배 괴리 — 원인 불명 (수정주가 혼용 가능성)`;
      }
    }

    // ── 5) priceSource 식별 ──
    let priceSource = 'UNKNOWN';
    if (parsedCandleClose > 0 && parsedCurrentPrice > 0) {
      if (Math.abs(parsedCandleClose - parsedCurrentPrice) / Math.min(parsedCandleClose, parsedCurrentPrice) < 0.05) {
        priceSource = 'CONSISTENT';
      } else {
        priceSource = 'KIS_DAILY_CANDLE_CLOSE'; // signal.price의 출처
      }
    } else if (parsedCandleClose > 0) {
      priceSource = 'KIS_DAILY_CANDLE_CLOSE';
    } else if (parsedCurrentPrice > 0) {
      priceSource = 'KIS_REST_PRICE';
    }

    // ── 6) recommendation ──
    let recommendation = '';
    if (anomalyResult.priceAnomaly) {
      recommendation =
        `가격 anomaly (괴리 ${(anomalyResult.gapPercent * 100).toFixed(2)}%) — ` +
        `signal.price(parsedCandleClose=${parsedCandleClose})와 KIS 현재가(${parsedCurrentPrice})가 20% 이상 괴리. `;
      if (multiplierReason.includes('액면분할')) {
        recommendation +=
          `원인: FID_ORG_ADJ_PRC=1 원주가 응답이 분할 전 가격을 반환. ` +
          `조치: getStockDailyCandles에서 FID_ORG_ADJ_PRC=0(수정주가)로 변경 필요.`;
      } else {
        recommendation +=
          `조치: 일봉 응답 stck_clpr 원본 값 검증, ` +
          `캔들과 현재가가 다른 단위(원/핍)로 파싱되는지 확인 필요.`;
      }
    } else {
      recommendation = '정상 — 분석 기준가와 실시간 현재가가 일치함.';
    }

    return NextResponse.json({
      success: true,
      stockCode,
      normalizedCode,
      stockName,
      normalizationApplied,
      currentPriceRawError,
      candleRawError,
      currentPriceRaw: currentPriceRaw ? {
        rt_cd: currentPriceRaw.rt_cd,
        msg_cd: currentPriceRaw.msg_cd,
        msg1: currentPriceRaw.msg1,
        output: currentPriceRaw.output, // 원본 그대로
      } : null,
      candleRaw: candleRaw ? {
        rt_cd: candleRaw.rt_cd,
        msg_cd: candleRaw.msg_cd,
        msg1: candleRaw.msg1,
        output1: candleRaw.output1, // 요약
        recent3: candleRawRecent3, // 최근 3개 일봉 원본 아이템
      } : null,
      parsed: {
        currentPrice: parsedCurrentPrice,
        currentPriceField: 'stck_prpr',
        candleClose: parsedCandleClose,
        candleCloseField: 'stck_clpr',
        candleOpen: parsedCandleOpen,
        candleOpenField: 'stck_oprc',
        candleHigh: parsedCandleHigh,
        candleHighField: 'stck_hgpr',
        candleLow: parsedCandleLow,
        candleLowField: 'stck_lwpr',
        candleDate: parsedCandleDate,
        candleDateField: 'stck_bsop_date',
        // FID_ORG_ADJ_PRC=1이면 원주가, 0이면 수정주가
        fidOrgAdjPrc: '1',
        fidOrgAdjPrcMeaning: '원주가 (액면분할 등 반영 안 됨)',
      },
      final: {
        signalPrice: parsedCandleClose, // TradingEngine.analyze가 candles[last].close를 signal.price로 사용
        lastClose: parsedCandleClose,
        currentPrice: parsedCurrentPrice,
      },
      multiplierApplied,
      multiplierReason,
      priceSource,
      priceAnomaly: anomalyResult.priceAnomaly,
      anomalyReason: anomalyResult.anomalyReason,
      gapPercent: anomalyResult.gapPercent,
      threshold: PRICE_ANOMALY_THRESHOLD,
      recommendation,
      // 진단 힌트
      hints: {
        FID_ORG_ADJ_PRC_EXPLANATION:
          'FID_ORG_ADJ_PRC=1 (원주가) — 액면분할/합병 전 원래 가격을 반환. ' +
          '분할 이후 일봉을 조회하면 분할 전 가격이 섞여 나옴. ' +
          '수정주가로 조회하려면 FID_ORG_ADJ_PRC=0 사용 권장.',
        SIGNAL_PRICE_SOURCE:
          'signal.price = candles[length-1].close (TradingEngine.analyze). ' +
          '즉, 일봉의 마지막 close가 신호 가격이 됨.',
        CURRENT_PRICE_SOURCE:
          'parsed.currentPrice = KIS inquire-price API의 stck_prpr. ' +
          '실시간 시세이므로 장중에는 캔들 close와 다를 수 있으나 20% 이상 괴리하면 비정상.',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: `가격 진단 실패: ${error instanceof Error ? error.message : 'Unknown'}`,
      },
      { status: 500 }
    );
  }
}
