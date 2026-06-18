// GET /api/positions/diagnostics
// 보유 포지션 단가 신뢰성 진단
// 각 보유 종목별로 DB Position.avgPrice / KIS 평균단가 / 매입금액/수량 계산값 비교
// 단가 괴리(reasonMismatch)가 있으면 자동청산 금지 안내
//
// 응답:
//   {
//     success: true,
//     totalPositions: N,
//     mismatchCount: M,
//     positions: [
//       {
//         stockCode, stockName,
//         db: { avgPrice, currentPrice, quantity, totalCost, ... },
//         kis: { rawBalanceItem, avgPriceFieldName, avgPriceRawValue, parsedAvgPrice, parsedCurrentPrice, parsedQuantity, evaluatedAmount, purchaseAmount, calculatedAvgPrice },
//         priceMismatch: boolean,
//         mismatchReason: string,
//         recommendation: string  // "재동기화 필요" / "정상" / "KIS 잔고 없음 — DB 삭제 필요"
//       }
//     ]
//   }

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';
import { getOrCreateKisConfigFromEnv } from '@/lib/kis-config-loader';

export async function GET() {
  try {
    // 1) DB에서 모든 DOMESTIC 포지션 조회 (스키마 mismatch 대비 safe select)
    let dbPositions: any[] = [];
    try {
      dbPositions = await db.position.findMany({
        where: { market: 'DOMESTIC' },
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
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
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

    // 2) KIS 잔고 조회
    const config = await getOrCreateKisConfigFromEnv();
    let kisBalance: any = null;
    let kisError: string | null = null;
    let kisRawOutput1: any[] = [];

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
        // output1 원본은 노출되지 않으므로, getAccountBalance에서 노출한 positions를 활용
        // 단, 진단 API는 클라이언트가 파싱한 결과를 그대로 사용
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
        recommendation = 'DB에서 삭제 필요 (DELETE /api/positions/resync)';
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

      diagnostics.push({
        stockCode,
        stockName: dbPos.stockName,
        db: {
          id: dbPos.id,
          avgPrice: dbPos.avgPrice,
          currentPrice: dbPos.currentPrice,
          quantity: dbPos.quantity,
          totalCost: dbPos.avgPrice * dbPos.quantity,
          profitLoss: dbPos.profitLoss,
          profitRate: dbPos.profitRate,
          strategy: dbPos.strategy,
          openedAt: dbPos.openedAt,
          updatedAt: dbPos.updatedAt,
        },
        kis: kisPos ? {
          rawBalanceItem: {
            // 원본 KIS output1 항목은 노출하지 않되, 파싱된 필드값을 모두 노출
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
        priceMismatch,
        mismatchReason,
        recommendation,
      });
    }

    // KIS에는 있는데 DB에는 없는 포지션도 별도 표시
    const dbCodes = new Set(dbPositions.map(p => p.stockCode));
    const orphanKisPositions = kisPositions
      .filter(p => !dbCodes.has(p.stockCode))
      .map(p => ({
        stockCode: p.stockCode,
        stockName: p.stockName,
        kis: {
          avgPriceFieldName: p.rawAvgPriceField,
          avgPriceRawValue: p.rawAvgPrice,
          parsedAvgPrice: p.avgPrice,
          parsedCurrentPrice: p.currentPrice,
          parsedQuantity: p.quantity,
          evaluatedAmount: p.evaluationAmount,
          purchaseAmount: p.purchaseAmount,
          calculatedAvgPrice: p.purchaseAmount && p.quantity ? p.purchaseAmount / p.quantity : null,
        },
        priceMismatch: false,
        mismatchReason: 'KIS 잔고에 있으나 DB에 없음 — 수동 매수 또는 외부에서 유입',
        recommendation: 'DB에 신규 추가 필요 (POST /api/positions/resync)',
      }));

    return NextResponse.json({
      success: true,
      totalDbPositions: dbPositions.length,
      totalKisPositions: kisPositions.length,
      mismatchCount,
      orphanKisCount: orphanKisPositions.length,
      kisAvailable: !!kisBalance,
      kisError,
      kisSummary: kisBalance ? {
        totalEvaluation: kisBalance.totalEvaluation,
        availableAmount: kisBalance.availableAmount,
        totalProfitLoss: kisBalance.totalProfitLoss,
        totalProfitRate: kisBalance.totalProfitRate,
      } : null,
      positions: [...diagnostics, ...orphanKisPositions],
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
