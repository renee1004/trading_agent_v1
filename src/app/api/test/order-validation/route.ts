// 주문 사전검증 테스트 엔드포인트
// DRY_RUN / PAPER 모드에서 주문 사전검증 로그가 정상적으로 남는지 검증
// 실제 주문 API는 절대 호출하지 않음 (DRY_RUN)
// PAPER 모드는 모의투자 KIS API로 실제 주문 접수 시도

import { NextRequest, NextResponse } from 'next/server';
import { addLog } from '@/lib/trading-agent';
import { getEffectiveTradingSettings, validateOrderExecution, EffectiveTradingSettings } from '@/lib/effective-settings';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';
import { getOrCreateKisConfigFromEnv } from '@/lib/kis-config-loader';

export const dynamic = 'force-dynamic';

/**
 * POST /api/test/order-validation
 * Body: { mode: 'DRY_RUN' | 'PAPER', market: 'OVERSEAS' | 'DOMESTIC' }
 *
 * DRY_RUN 테스트:
 *   - orderExecutionMode=DRY_RUN으로 설정
 *   - validateOrderExecution() 호출 → canPlaceOrder=false, blockedReason 확인
 *   - 주문 사전검증 로그 기록
 *   - 실제 KIS API 호출 없음
 *
 * PAPER 테스트:
 *   - orderExecutionMode=PAPER으로 설정
 *   - validateOrderExecution() 통과 시 KIS 모의투자 API로 실제 주문 접수
 *   - 1회 주문금액 100달러 이하, 하루 1건 제한
 *   - 주문 전 currentPrice 재조회
 *   - RISK 로그 대상이면 주문 차단
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const mode = body.mode || 'DRY_RUN';
  const market = body.market || 'OVERSEAS';

  if (!['DRY_RUN', 'PAPER'].includes(mode)) {
    return NextResponse.json({ success: false, error: 'mode는 DRY_RUN 또는 PAPER만 허용' }, { status: 400 });
  }
  if (!['OVERSEAS', 'DOMESTIC'].includes(market)) {
    return NextResponse.json({ success: false, error: 'market는 OVERSEAS 또는 DOMESTIC만 허용' }, { status: 400 });
  }

  addLog('INFO', market, `[TEST] 주문 사전검증 테스트 시작 (mode=${mode}, market=${market})`);

  // ── 1. 현재 설정 로드 ──
  const { settings: originalSettings } = await getEffectiveTradingSettings();

  // ── 2. 테스트 설정 오버라이드 ──
  const testSettings: EffectiveTradingSettings = {
    ...originalSettings,
    tradingMode: 'DEMO',
    orderExecutionMode: mode,
    // 테스트 조건에 맞춰 해외 주문 활성화 (PAPER 모드에서 주문 접수 필요)
    enableOverseasOrder: mode === 'PAPER' ? true : originalSettings.enableOverseasOrder,
    enableOverseasAnalysis: true,
    autoDomesticOrderEnabled: mode === 'PAPER' ? true : originalSettings.autoDomesticOrderEnabled,
    allowRealDomesticOrder: false,
    allowRealOverseasOrder: false,
    killSwitchEnabled: false,
    maxDomesticOrderAmount: 100000,
    maxOverseasOrderAmount: 100,     // USD 100달러
    maxDailyDomesticOrders: 1,
    maxDailyOverseasOrders: 1,
    maxOpenDomesticPositions: 1,
    maxOpenOverseasPositions: 1,
    maxOverseasPriceGapPercent: 0.05, // 테스트용 5% 허용
  };

  addLog('INFO', market, `[TEST] 테스트 설정: mode=${testSettings.tradingMode}/${testSettings.orderExecutionMode}, killSwitch=${testSettings.killSwitchEnabled}, allowRealDomestic=${testSettings.allowRealDomesticOrder}, allowRealOverseas=${testSettings.allowRealOverseasOrder}, maxOverseasOrderAmount=${testSettings.maxOverseasOrderAmount}USD, maxDailyOverseasOrders=${testSettings.maxDailyOverseasOrders}`);

  // ── 3. KIS isDemo 확인 ──
  let isDemo = true;
  try {
    const kisConfig = await db.kisConfig.findFirst();
    if (kisConfig) {
      isDemo = kisConfig.isDemo;
    }
  } catch (_e) { /* 기본값 유지 */ }

  addLog('INFO', market, `[TEST] KIS isDemo=${isDemo}`);

  // ── 4. 일일 주문 건수 & 보유 포지션 수 조회 ──
  let dailyOrderCount = 0;
  let openPositions = 0;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    dailyOrderCount = await db.tradeHistory.count({
      where: {
        market,
        tradedAt: { gte: today },
        status: { notIn: ['CANCELLED', 'FAILED'] },
      },
    });
    openPositions = await db.position.count({
      where: { market },
    });
  } catch (_e) { /* 0 유지 */ }

  addLog('INFO', market, `[TEST] 일일 주문 건수=${dailyOrderCount}, 보유 포지션=${openPositions}`);

  // ── 5. 테스트 BUY 시그널 생성 ──
  // 해외: NVDA @ $95 (1주 = $95, maxOverseasOrderAmount=$100 이내)
  // 국내: 테스트종목 @ 50000원 (1주 = 50000원, maxDomesticOrderAmount=100000 이내)
  const testSignalPrice = market === 'OVERSEAS' ? 95 : 50000;
  const testQuantity = 1;
  const testStockCode = market === 'OVERSEAS' ? 'NVDA' : '005930';
  const testStockName = market === 'OVERSEAS' ? 'NVIDIA' : '삼성전자';
  const testExchangeCode = market === 'OVERSEAS' ? 'NAS' : undefined;

  addLog('INFO', market, `[TEST] 테스트 BUY 시그널: ${testStockName}(${testStockCode}) @ ${testSignalPrice} x ${testQuantity}주`);

  // ── 6. 가용금액 조회 (KIS API) ──
  let availableAmount = 0;
  let currentPriceField = 'last';
  let priceGapPercent = 0;

  if (mode === 'PAPER') {
    // PAPER 모드: 실제 잔고 및 현재가 조회
    try {
      const kisConfig = await getOrCreateKisConfigFromEnv();
      if (kisConfig) {
        const kisClient = new KisApiClient(kisConfig);
        await kisClient.ensureToken();

        if (market === 'OVERSEAS') {
          const balance = await kisClient.getOverseasAccountBalance();
          availableAmount = balance.availableAmount;
          addLog('INFO', market, `[TEST] 해외 가용금액: $${availableAmount}`);

          // 주문 전 currentPrice 재조회
          const priceInfo = await kisClient.getOverseasCurrentPrice(testStockCode, testExchangeCode || 'NAS');
          currentPriceField = priceInfo.currentPriceField;
          const livePrice = priceInfo.currentPrice;
          priceGapPercent = testSignalPrice > 0 && livePrice > 0
            ? Math.abs(livePrice - testSignalPrice) / testSignalPrice
            : 0;

          addLog('INFO', market, `[TEST] 해외 현재가 재조회: livePrice=${livePrice}, currentPriceField=${currentPriceField}, priceGapPercent=${(priceGapPercent * 100).toFixed(2)}%`, {
            normalizedSymbol: priceInfo.normalizedSymbol,
            currentPriceField: priceInfo.currentPriceField,
            rawPriceFields: priceInfo.rawPriceFields,
          });

          // RISK 체크: 괴리율이 임계치 초과 시 주문 차단
          if (priceGapPercent > testSettings.maxOverseasPriceGapPercent) {
            addLog('RISK', market, `[TEST] 해외 주문 차단: 괴리율 초과 (${(priceGapPercent * 100).toFixed(2)}% > ${(testSettings.maxOverseasPriceGapPercent * 100).toFixed(2)}%)`);
          }
        } else {
          const balance = await kisClient.getAccountBalance();
          availableAmount = balance.availableAmount;
          addLog('INFO', market, `[TEST] 국내 가용금액: ${availableAmount}원`);
        }
      } else {
        addLog('INFO', market, `[TEST] KIS 설정 없음 - 가용금액 0`);
      }
    } catch (error) {
      addLog('ERROR', market, `[TEST] 가용금액/현재가 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  } else {
    // DRY_RUN: 가용금액 조회 안 함 (어차피 주문 차단됨)
    availableAmount = 0;
  }

  // ── 7. 주문 사전검증 ──
  const validation = validateOrderExecution(
    testSettings,
    market,
    isDemo,
    testSignalPrice,
    testQuantity,
    availableAmount,
    dailyOrderCount,
    openPositions,
    currentPriceField,
    market === 'OVERSEAS' ? priceGapPercent : undefined,
  );

  // 주문 사전검증 로그 (executeOrder와 동일한 포맷)
  addLog('INFO', market, `주문 사전검증: ${testStockName} BUY`, {
    market: validation.market,
    tradingMode: validation.tradingMode,
    orderExecutionMode: validation.orderExecutionMode,
    isDemo: validation.isDemo,
    enableOrder: validation.enableOrder,
    allowRealOrder: validation.allowRealOrder,
    killSwitchEnabled: validation.killSwitchEnabled,
    currentPrice: validation.currentPrice,
    currentPriceField: validation.currentPriceField,
    priceGapPercent: validation.priceGapPercent,
    maxPriceGapPercent: validation.maxPriceGapPercent,
    availableAmount: validation.availableAmount,
    calculatedQuantity: validation.calculatedQuantity,
    estimatedOrderAmount: validation.estimatedOrderAmount,
    maxOrderAmount: validation.maxOrderAmount,
    dailyOrderCount: validation.dailyOrderCount,
    maxDailyOrders: validation.maxDailyOrders,
    openPositions: validation.openPositions,
    maxOpenPositions: validation.maxOpenPositions,
    canPlaceOrder: validation.canPlaceOrder,
    blockedReason: validation.blockedReason,
  });

  // ── 8. 결과 기록 ──
  const testResult = {
    mode,
    market,
    validation,
    stockCode: testStockCode,
    stockName: testStockName,
    signalPrice: testSignalPrice,
    quantity: testQuantity,
  };

  if (!validation.canPlaceOrder) {
    addLog('RISK', market, `[TEST] 주문 차단: ${validation.blockedReason}`, {
      stockCode: testStockCode,
      signalType: 'BUY',
      strategy: 'TEST',
      blockedReason: validation.blockedReason,
    });
  }

  // ── 9. PAPER 모드: 실제 주문 접수 시도 ──
  let orderResult: { success: boolean; orderNo: string; message: string; rt_cd?: string; msg_cd?: string; msg1?: string } | null = null;

  if (mode === 'PAPER' && validation.canPlaceOrder) {
    addLog('INFO', market, `[TEST] PAPER 모드: 실제 모의투자 주문 접수 시도`);

    try {
      const kisConfig = await getOrCreateKisConfigFromEnv();
      if (kisConfig && isDemo) {
        const kisClient = new KisApiClient(kisConfig);
        await kisClient.ensureToken();

        if (market === 'OVERSEAS') {
          // 해외 주문
          const orderRequest = {
            stockCode: testStockCode,
            orderType: 'BUY' as const,
            quantity: 1,
            price: testSignalPrice,
            orderKind: '01' as const, // 시장가
            market: 'OVERSEAS' as const,
            exchangeCode: testExchangeCode,
          };

          try {
            const result = await kisClient.placeOverseasOrder(orderRequest);
            const isKisSuccess = result.status !== 'FAILED';
            orderResult = {
              success: isKisSuccess,
              orderNo: result.orderNo,
              message: result.message,
              rt_cd: result.rt_cd,
              msg_cd: result.msg_cd,
              msg1: result.message,
            };
            if (isKisSuccess) {
              addLog('TRADE', market, `[TEST] PAPER 해외 주문 접수 성공: ${testStockName} 1주 @ ${testSignalPrice} (${result.orderNo})`, {
                orderNo: result.orderNo,
                rt_cd: result.rt_cd,
                msg_cd: result.msg_cd,
              });
            } else {
              addLog('ERROR', market, `[TEST] PAPER 해외 주문 접수 실패: ${result.message}`, {
                rt_cd: result.rt_cd,
                msg_cd: result.msg_cd,
                msg1: result.message,
                stockCode: testStockCode,
                quantity: 1,
                price: testSignalPrice,
              });
            }
          } catch (orderError) {
            const errorMsg = orderError instanceof Error ? orderError.message : String(orderError);
            // KIS API 에러에서 rt_cd/msg_cd 추출
            let rt_cd = 'UNKNOWN';
            let msg_cd = 'UNKNOWN';
            let msg1 = errorMsg;
            try {
              const parsed = JSON.parse(errorMsg);
              rt_cd = parsed.rt_cd || rt_cd;
              msg_cd = parsed.msg_cd || msg_cd;
              msg1 = parsed.msg1 || msg1;
            } catch (_e) { /* 파싱 실패 시 기본값 */ }

            orderResult = {
              success: false,
              orderNo: '',
              message: errorMsg,
              rt_cd,
              msg_cd,
              msg1,
            };
            addLog('ERROR', market, `[TEST] PAPER 해외 주문 접수 실패: ${errorMsg}`, {
              rt_cd,
              msg_cd,
              msg1,
              stockCode: testStockCode,
              quantity: 1,
              price: testSignalPrice,
            });
          }
        } else {
          // 국내 주문
          const orderRequest = {
            stockCode: testStockCode,
            orderType: 'BUY' as const,
            quantity: 1,
            price: testSignalPrice,
            orderKind: '01' as const, // 시장가
            market: 'DOMESTIC' as const,
          };

          try {
            const result = await kisClient.placeOrder(orderRequest);
            const isKisSuccess = result.status !== 'FAILED';
            orderResult = {
              success: isKisSuccess,
              orderNo: result.orderNo,
              message: result.message,
              rt_cd: result.rt_cd,
              msg_cd: result.msg_cd,
              msg1: result.message,
            };
            if (isKisSuccess) {
              addLog('TRADE', market, `[TEST] PAPER 국내 주문 접수 성공: ${testStockName} 1주 @ ${testSignalPrice} (${result.orderNo})`, {
                orderNo: result.orderNo,
                rt_cd: result.rt_cd,
                msg_cd: result.msg_cd,
              });
            } else {
              addLog('ERROR', market, `[TEST] PAPER 국내 주문 접수 실패: ${result.message}`, {
                rt_cd: result.rt_cd,
                msg_cd: result.msg_cd,
                msg1: result.message,
                stockCode: testStockCode,
                quantity: 1,
                price: testSignalPrice,
              });
            }
          } catch (orderError) {
            const errorMsg = orderError instanceof Error ? orderError.message : String(orderError);
            let rt_cd = 'UNKNOWN';
            let msg_cd = 'UNKNOWN';
            let msg1 = errorMsg;
            try {
              const parsed = JSON.parse(errorMsg);
              rt_cd = parsed.rt_cd || rt_cd;
              msg_cd = parsed.msg_cd || msg_cd;
              msg1 = parsed.msg1 || msg1;
            } catch (_e) { /* 파싱 실패 시 기본값 */ }

            orderResult = {
              success: false,
              orderNo: '',
              message: errorMsg,
              rt_cd,
              msg_cd,
              msg1,
            };
            addLog('ERROR', market, `[TEST] PAPER 국내 주문 접수 실패: ${errorMsg}`, {
              rt_cd,
              msg_cd,
              msg1,
              stockCode: testStockCode,
              quantity: 1,
              price: testSignalPrice,
            });
          }
        }
      } else if (!isDemo) {
        orderResult = {
          success: false,
          orderNo: '',
          message: 'PAPER 모드는 모의투자 계정에서만 허용 (isDemo=false)',
        };
        addLog('RISK', market, `[TEST] PAPER 모드 차단: isDemo=false`);
      } else {
        orderResult = {
          success: false,
          orderNo: '',
          message: 'KIS 설정 없음 - 주문 불가',
        };
        addLog('ERROR', market, `[TEST] KIS 설정 없음 - PAPER 주문 불가`);
      }
    } catch (error) {
      orderResult = {
        success: false,
        orderNo: '',
        message: `PAPER 주문 예외: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
      addLog('ERROR', market, `[TEST] PAPER 주문 예외: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  // ── 10. 최종 결과 ──
  addLog('INFO', market, `[TEST] 주문 사전검증 테스트 완료 (mode=${mode}, canPlaceOrder=${validation.canPlaceOrder}, blockedReason="${validation.blockedReason}")`);

  // 현재 ordersPlaced 확인 (마지막 사이클 결과)
  let lastOrdersPlaced = 0;
  try {
    const { getAgentStatus } = await import('@/lib/trading-agent');
    const status = getAgentStatus();
    lastOrdersPlaced = status.lastCycleResult?.ordersPlaced ?? 0;
  } catch (_e) { /* 무시 */ }

  return NextResponse.json({
    success: true,
    test: mode,
    market,
    isDemo,
    testSignal: {
      stockCode: testStockCode,
      stockName: testStockName,
      signalType: 'BUY',
      price: testSignalPrice,
      quantity: testQuantity,
      exchangeCode: testExchangeCode,
    },
    testSettings: {
      tradingMode: testSettings.tradingMode,
      orderExecutionMode: testSettings.orderExecutionMode,
      killSwitchEnabled: testSettings.killSwitchEnabled,
      allowRealDomesticOrder: testSettings.allowRealDomesticOrder,
      allowRealOverseasOrder: testSettings.allowRealOverseasOrder,
      enableOverseasOrder: testSettings.enableOverseasOrder,
      maxOverseasOrderAmount: testSettings.maxOverseasOrderAmount,
      maxDailyOverseasOrders: testSettings.maxDailyOverseasOrders,
      maxOpenOverseasPositions: testSettings.maxOpenOverseasPositions,
    },
    validation: {
      canPlaceOrder: validation.canPlaceOrder,
      blockedReason: validation.blockedReason,
      orderExecutionMode: validation.orderExecutionMode,
      currentPrice: validation.currentPrice,
      currentPriceField: validation.currentPriceField,
      priceGapPercent: validation.priceGapPercent,
      estimatedOrderAmount: validation.estimatedOrderAmount,
      dailyOrderCount: validation.dailyOrderCount,
      openPositions: validation.openPositions,
    },
    orderResult,
    lastOrdersPlaced,
    // DRY_RUN 기대값
    expected: mode === 'DRY_RUN' ? {
      canPlaceOrder: false,
      blockedReason: '주문 드라이런: 실제 주문 차단',
      ordersPlaced: 0,
    } : undefined,
  });
}
