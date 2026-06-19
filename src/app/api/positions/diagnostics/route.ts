// GET /api/positions/diagnostics
// 보유 포지션 단가 신뢰성 진단
// 각 보유 종목별로 DB Position.avgPrice / KIS 평균단가 / 매입금액/수량 계산값 비교
// 단가 괴리(reasonMismatch)가 있으면 자동청산 금지 안내
//
// 쿼리 파라미터:
//   ?code=005930  → 특정 종목만 진단 (삼성전자 단가 추적용)
//
// 응답 (종목별):
//   {
//     stockCode, stockName,
//     quantity, currentPrice, avgPrice, displayPrice, displayPriceSource,
//     db: { avgPrice, currentPrice, quantity, totalCost, ... },
//     kis: { rawBalanceItem, avgPriceFieldName, avgPriceRawValue, currentPriceFieldName, currentPriceRawValue, parsedAvgPrice, parsedCurrentPrice, parsedQuantity, evaluatedAmount, purchaseAmount, calculatedAvgPrice },
//     latestFilledTrade: { avgFillPrice, filledPrice, status, tradedAt, source, orderExecutionMode } | null,
//     priceMismatch: boolean,
//     mismatchReason: string,
//     recommendation: string
//   }
//
// displayPriceSource 값:
//   - "KIS_BALANCE_AVG_PRICE" — KIS 잔고의 pchs_avg_pric (가장 신뢰)
//   - "KIS_BALANCE_CALCULATED" — 매입금액/수량으로 계산
//   - "DB_POSITION_AVG_PRICE" — DB Position.avgPrice (백업)
//   - "TRADE_HISTORY_AVG_FILL_PRICE" — 최근 FILLED 거래의 avgFillPrice
//   - "TRADE_HISTORY_PRICE" — 최근 거래의 price (신호가)
//   - "UNKNOWN" — 출처 불명

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';
import { getOrCreateKisConfigFromEnv } from '@/lib/kis-config-loader';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const codeFilter = searchParams.get('code'); // 특정 종목 진단

    // 1) DB에서 모든 DOMESTIC 포지션 조회 (스키마 mismatch 대비 safe select)
    let dbPositions: any[] = [];
    try {
      dbPositions = await db.position.findMany({
        where: {
          market: 'DOMESTIC',
          ...(codeFilter ? { stockCode: codeFilter } : {}),
        },
        select: {
          id: true,
          stockCode: true,
          stockName: true,
          quantity: true,
          avgPrice: true,
          currentPrice: true,
          profitLoss: true,
          profitRate: true,
          strategy: true,
          market: true,
          currency: true,
          source: true,
          openedAt: true,
          updatedAt: true,
        },
      });
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      // source 컬럼이 없는 경우 — select에서 source 제거하고 재시도
      if (msg.includes('source') || msg.includes('does not exist')) {
        console.warn('[Position Diagnostics] source 컬럼 없음 — 재시도');
        try {
          dbPositions = await db.position.findMany({
            where: {
              market: 'DOMESTIC',
              ...(codeFilter ? { stockCode: codeFilter } : {}),
            },
            select: {
              id: true,
              stockCode: true,
              stockName: true,
              quantity: true,
              avgPrice: true,
              currentPrice: true,
              profitLoss: true,
              profitRate: true,
              strategy: true,
              market: true,
              currency: true,
              openedAt: true,
              updatedAt: true,
            },
          });
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return NextResponse.json(
            {
              success: false,
              error: 'Position DB 조회 실패',
              code: 'DB_QUERY_FAILED',
              dbError: retryMsg,
              hint: 'Railway DB에서 Position v2 컬럼이 생성되었는지 확인하세요 (prisma migrate deploy).',
            },
            { status: 500 }
          );
        }
      } else {
        return NextResponse.json(
          {
            success: false,
            error: 'Position DB 조회 실패',
            code: 'DB_QUERY_FAILED',
            dbError: msg,
            hint: 'Railway DB에서 Position v2 컬럼이 생성되었는지 확인하세요 (prisma migrate deploy).',
          },
          { status: 500 }
        );
      }
    }

    // 2) KIS 잔고 조회
    const config = await getOrCreateKisConfigFromEnv();
    let kisBalance: any = null;
    let kisError: string | null = null;

    if (config) {
      try {
        const client = new KisApiClient({
          appKey: config.appKey,
          appSecret: config.appSecret,
          accountNo: config.accountNo,
          isDemo: config.isDemo,
          accessToken: config.accessToken || undefined,
          tokenExpiresAt: config.tokenExpiresAt ?? undefined,
        });
        kisBalance = await client.getAccountBalance();
      } catch (e) {
        kisError = e instanceof Error ? e.message : String(e);
      }
    } else {
      kisError = 'KIS 설정 없음 (KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NO 환경변수 확인 필요)';
    }

    const kisPositions: any[] = kisBalance?.positions ?? [];

    // 3) 종목별 비교
    const diagnostics: any[] = [];
    let mismatchCount = 0;

    // DB 기준 순회
    for (const dbPos of dbPositions) {
      const stockCode = dbPos.stockCode;
      const kisPos = kisPositions.find(p => p.stockCode === stockCode);

      // 3a) 최근 FILLED 거래 조회 (TradeHistory)
      let latestFilledTrade: any = null;
      try {
        const latestTrades = await db.tradeHistory.findMany({
          where: { stockCode, status: 'FILLED' },
          orderBy: { tradedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            stockCode: true,
            stockName: true,
            tradeType: true,
            quantity: true,
            price: true,
            status: true,
            source: true,
            orderExecutionMode: true,
            orderPrice: true,
            filledPrice: true,
            avgFillPrice: true,
            signalReason: true,
            tradedAt: true,
          },
        });
        latestFilledTrade = latestTrades[0] ?? null;
      } catch (_tradeErr) {
        // TradeHistory v2 컬럼 없을 수 있음 — 무시
        latestFilledTrade = null;
      }

      // 3b) 최근 거래 (status 무관)도 별도 조회
      let latestTrade: any = null;
      try {
        const latestAnyTrades = await db.tradeHistory.findMany({
          where: { stockCode },
          orderBy: { tradedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            source: true,
            orderExecutionMode: true,
            price: true,
            orderPrice: true,
            filledPrice: true,
            avgFillPrice: true,
            tradedAt: true,
            signalReason: true,
          },
        });
        latestTrade = latestAnyTrades[0] ?? null;
      } catch (_e) {
        latestTrade = null;
      }

      const calculatedAvgPrice = kisPos?.purchaseAmount && kisPos?.quantity
        ? kisPos.purchaseAmount / kisPos.quantity
        : null;

      let priceMismatch = false;
      let mismatchReason = '';
      let recommendation = '정상';

      if (!kisPos) {
        // DB에 있는데 KIS 잔고에 없음
        priceMismatch = true;
        mismatchReason = 'KIS 잔고에 없는 포지션 — 전량 매도/삭제된 포지션';
        recommendation = 'DB에서 삭제 필요 (POST /api/positions/resync)';
      } else {
        // 1) avgPrice <= 0 (DB)
        if (dbPos.avgPrice <= 0) {
          priceMismatch = true;
          mismatchReason = `DB avgPrice가 0 이하 (${dbPos.avgPrice}) — 신뢰 불가`;
          recommendation = 'DB 재동기화 필요 (POST /api/positions/resync)';
        }
        // 2) DB avgPrice vs KIS avgPrice 괴리 30% 이상
        else if (kisPos.avgPrice > 0 && Math.abs(dbPos.avgPrice - kisPos.avgPrice) / kisPos.avgPrice > 0.30) {
          priceMismatch = true;
          mismatchReason = `DB avgPrice(${dbPos.avgPrice}) vs KIS avgPrice(${kisPos.avgPrice}) 괴리 ${((Math.abs(dbPos.avgPrice - kisPos.avgPrice) / kisPos.avgPrice) * 100).toFixed(1)}%`;
          recommendation = 'DB 재동기화 필요 (POST /api/positions/resync)';
        }
        // 3) KIS 자체 괴리 (avgPrice vs calculatedAvgPrice)
        else if (kisPos.priceMismatch) {
          priceMismatch = true;
          mismatchReason = `KIS 응답 내부 괴리: ${kisPos.mismatchReason}`;
          recommendation = 'KIS 잔고 응답 검증 필요 — 수동 확인 권장';
        }
        // 4) currentPrice / avgPrice 괴리 30% 이상 (DB)
        else if (dbPos.currentPrice && dbPos.avgPrice > 0 &&
                 Math.abs(dbPos.currentPrice - dbPos.avgPrice) / dbPos.avgPrice > 0.30) {
          priceMismatch = true;
          mismatchReason = `DB currentPrice(${dbPos.currentPrice}) / avgPrice(${dbPos.avgPrice}) 괴리 ${((Math.abs(dbPos.currentPrice - dbPos.avgPrice) / dbPos.avgPrice) * 100).toFixed(1)}%`;
          recommendation = '단가 재확인 필요 — DB 재동기화 권장';
        }
      }

      if (priceMismatch) mismatchCount++;

      // ── displayPriceSource 결정 ──
      // 우선순위: KIS_BALANCE_AVG_PRICE > KIS_BALANCE_CALCULATED > DB_POSITION_AVG_PRICE > TRADE_HISTORY_AVG_FILL_PRICE > TRADE_HISTORY_PRICE > UNKNOWN
      let displayPrice: number = dbPos.avgPrice ?? 0;
      let displayPriceSource = 'UNKNOWN';
      if (kisPos?.avgPrice && kisPos.avgPrice > 0) {
        displayPrice = kisPos.avgPrice;
        displayPriceSource = 'KIS_BALANCE_AVG_PRICE';
      } else if (calculatedAvgPrice && calculatedAvgPrice > 0) {
        displayPrice = calculatedAvgPrice;
        displayPriceSource = 'KIS_BALANCE_CALCULATED';
      } else if (dbPos.avgPrice && dbPos.avgPrice > 0) {
        displayPrice = dbPos.avgPrice;
        displayPriceSource = 'DB_POSITION_AVG_PRICE';
      } else if (latestFilledTrade?.avgFillPrice != null) {
        displayPrice = latestFilledTrade.avgFillPrice;
        displayPriceSource = 'TRADE_HISTORY_AVG_FILL_PRICE';
      } else if (latestFilledTrade?.filledPrice != null) {
        displayPrice = latestFilledTrade.filledPrice;
        displayPriceSource = 'TRADE_HISTORY_FILLED_PRICE';
      } else if (latestTrade?.price != null) {
        displayPrice = latestTrade.price;
        displayPriceSource = 'TRADE_HISTORY_PRICE';
      }

      diagnostics.push({
        stockCode,
        stockName: dbPos.stockName,
        quantity: dbPos.quantity,
        currentPrice: dbPos.currentPrice,
        avgPrice: dbPos.avgPrice,
        displayPrice,
        displayPriceSource,
        source: dbPos.source ?? (kisPos ? 'KIS_BALANCE' : 'MANUAL'),
        db: {
          id: dbPos.id,
          avgPrice: dbPos.avgPrice,
          currentPrice: dbPos.currentPrice,
          quantity: dbPos.quantity,
          totalCost: dbPos.avgPrice * dbPos.quantity,
          profitLoss: dbPos.profitLoss,
          profitRate: dbPos.profitRate,
          strategy: dbPos.strategy,
          source: dbPos.source,
          openedAt: dbPos.openedAt,
          updatedAt: dbPos.updatedAt,
        },
        kis: kisPos ? {
          rawBalanceItem: {
            pdno: kisPos.stockCode,
            prdt_name: kisPos.stockName,
            hldg_qty: kisPos.quantity,
            pchs_avg_pric: kisPos.rawAvgPrice,
            prpr: kisPos.rawCurrentPrice,
            pchs_amt: kisPos.purchaseAmount,
            evlu_amt: kisPos.evaluationAmount,
            evlu_pfls_amt: kisPos.profitLoss,
            evlu_pfls_rt: kisPos.profitRate,
          },
          avgPriceFieldName: kisPos.rawAvgPriceField,
          avgPriceRawValue: kisPos.rawAvgPrice,
          currentPriceFieldName: kisPos.rawCurrentPriceField,
          currentPriceRawValue: kisPos.rawCurrentPrice,
          parsedAvgPrice: kisPos.avgPrice,
          parsedCurrentPrice: kisPos.currentPrice,
          parsedQuantity: kisPos.quantity,
          evaluatedAmount: kisPos.evaluationAmount,
          purchaseAmount: kisPos.purchaseAmount,
          calculatedAvgPrice,
        } : null,
        latestFilledTrade: latestFilledTrade ? {
          id: latestFilledTrade.id,
          tradeType: latestFilledTrade.tradeType,
          quantity: latestFilledTrade.quantity,
          status: latestFilledTrade.status,
          source: latestFilledTrade.source,
          orderExecutionMode: latestFilledTrade.orderExecutionMode,
          signalPrice: latestFilledTrade.price,
          orderPrice: latestFilledTrade.orderPrice,
          filledPrice: latestFilledTrade.filledPrice,
          avgFillPrice: latestFilledTrade.avgFillPrice,
          tradedAt: latestFilledTrade.tradedAt,
          signalReason: latestFilledTrade.signalReason,
        } : null,
        latestTrade: latestTrade ? {
          status: latestTrade.status,
          source: latestTrade.source,
          orderExecutionMode: latestTrade.orderExecutionMode,
          signalPrice: latestTrade.price,
          orderPrice: latestTrade.orderPrice,
          filledPrice: latestTrade.filledPrice,
          avgFillPrice: latestTrade.avgFillPrice,
          tradedAt: latestTrade.tradedAt,
          signalReason: latestTrade.signalReason,
        } : null,
        priceMismatch,
        mismatchReason,
        recommendation,
      });
    }

    // ── KIS에는 있는데 DB에는 없는 포지션 (KIS_ONLY) ──
    // codeFilter가 있든 없든 무조건 처리 —
    // 삼성전자 005930이 DB에 없고 KIS에만 있어도 진단 결과에 반드시 포함되어야 함.
    const dbCodes = new Set(dbPositions.map(p => p.stockCode));
    let kisOnlyPositions = kisPositions
      .filter(p => !dbCodes.has(p.stockCode))
      .filter(p => !codeFilter || p.stockCode === codeFilter);

    // KIS_ONLY 포지션 진단 객체 생성
    const kisOnlyDiagnostics = kisOnlyPositions.map((p: any) => {
      const calculatedAvgPrice = p.purchaseAmount && p.quantity
        ? p.purchaseAmount / p.quantity
        : null;

      // displayPriceSource 결정 (KIS 우선)
      let displayPrice: number = 0;
      let displayPriceSource = 'UNKNOWN';
      if (p.avgPrice && p.avgPrice > 0) {
        displayPrice = p.avgPrice;
        displayPriceSource = 'KIS_BALANCE_AVG_PRICE';
      } else if (calculatedAvgPrice && calculatedAvgPrice > 0) {
        displayPrice = calculatedAvgPrice;
        displayPriceSource = 'KIS_BALANCE_CALCULATED';
      }

      // 단가 신뢰성 체크
      let priceMismatch = false;
      let mismatchReason = '';
      let recommendation = 'DB Position 없음 — KIS 기준으로 resync 필요 (POST /api/positions/resync)';

      if (p.avgPrice <= 0 && (!calculatedAvgPrice || calculatedAvgPrice <= 0)) {
        priceMismatch = true;
        mismatchReason = `KIS 평균단가 0 이하 (rawAvgPrice=${p.rawAvgPrice}, purchaseAmount=${p.purchaseAmount}, quantity=${p.quantity}) — 신뢰 불가`;
        recommendation = 'KIS 잔고 응답 검증 필요 — 수동 확인 권장';
      } else if (p.priceMismatch) {
        priceMismatch = true;
        mismatchReason = `KIS 응답 내부 괴리: ${p.mismatchReason}`;
        recommendation = 'KIS 잔고 응답 검증 필요 — 수동 확인 권장';
      } else if (p.avgPrice > 0 && calculatedAvgPrice &&
                 Math.abs(p.avgPrice - calculatedAvgPrice) / p.avgPrice > 0.30) {
        priceMismatch = true;
        mismatchReason = `KIS avgPrice(${p.avgPrice}) vs calculated(${calculatedAvgPrice}) 괴리 ${((Math.abs(p.avgPrice - calculatedAvgPrice) / p.avgPrice) * 100).toFixed(1)}%`;
        recommendation = 'KIS 잔고 응답 검증 필요 — 수동 확인 권장';
      }

      return {
        stockCode: p.stockCode,
        stockName: p.stockName,
        quantity: p.quantity,
        currentPrice: p.currentPrice,
        avgPrice: p.avgPrice,
        displayPrice,
        displayPriceSource,
        source: 'KIS_ONLY',
        db: null,
        kis: {
          rawBalanceItem: {
            pdno: p.stockCode,
            prdt_name: p.stockName,
            hldg_qty: p.quantity,
            pchs_avg_pric: p.rawAvgPrice,
            prpr: p.rawCurrentPrice,
            pchs_amt: p.purchaseAmount,
            evlu_amt: p.evaluationAmount,
            evlu_pfls_amt: p.profitLoss,
            evlu_pfls_rt: p.profitRate,
          },
          avgPriceFieldName: p.rawAvgPriceField,
          avgPriceRawValue: p.rawAvgPrice,
          currentPriceFieldName: p.rawCurrentPriceField,
          currentPriceRawValue: p.rawCurrentPrice,
          parsedAvgPrice: p.avgPrice,
          parsedCurrentPrice: p.currentPrice,
          parsedQuantity: p.quantity,
          evaluatedAmount: p.evaluationAmount,
          purchaseAmount: p.purchaseAmount,
          calculatedAvgPrice,
        },
        latestFilledTrade: null,
        latestTrade: null,
        priceMismatch,
        mismatchReason,
        recommendation,
      };
    });

    return NextResponse.json({
      success: true,
      codeFilter: codeFilter || null,
      totalDbPositions: dbPositions.length,
      totalKisPositions: kisPositions.length,
      mismatchCount,
      kisOnlyCount: kisOnlyDiagnostics.length,
      orphanKisCount: kisOnlyDiagnostics.length, // 하위 호환 — 동일 값
      kisAvailable: !!kisBalance,
      kisError,
      kisSummary: kisBalance ? {
        totalEvaluation: kisBalance.totalEvaluation,
        availableAmount: kisBalance.availableAmount,
        totalProfitLoss: kisBalance.totalProfitLoss,
        totalProfitRate: kisBalance.totalProfitRate,
      } : null,
      positions: [...diagnostics, ...kisOnlyDiagnostics],
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: `포지션 진단 실패: ${error instanceof Error ? error.message : 'Unknown'}`,
      },
      { status: 500 }
    );
  }
}
