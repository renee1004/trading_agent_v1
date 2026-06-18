// POST /api/positions/resync
// DB Position을 KIS 잔고 기준으로 재동기화
// 단가 신뢰성 문제 해결용: 잘못된 avgPrice/quantity를 KIS 잔고 원본으로 교체
//
// 동작 순서:
//   1. 현재 DB Position과 KIS 잔고 원본을 로그로 저장
//   2. KIS 잔고에 없는 DB Position 삭제 (전량 매도/오류)
//   3. KIS 잔고에 있는 포지션은 avgPrice/quantity/currentPrice/profitLoss/profitRate/source 갱신
//   4. 단가 sanity check (avgPrice <= 0, 30% 괴리) — 위반 시 해당 종목 스킵
//   5. 결과 반환 (synced/added/removed/skipped 리스트)
//
// 요청 본문:
//   { dryRun: true }  -> 실제 DB 변경 없이 변경 예정 내역만 반환
//   { dryRun: false } -> (기본) 실제 DB 변경

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';
import { getOrCreateKisConfigFromEnv } from '@/lib/kis-config-loader';
import { prisma } from '@/lib/prisma';

interface ResyncPlan {
  stockCode: string;
  stockName: string;
  action: 'UPDATE' | 'CREATE' | 'DELETE' | 'SKIP_MISMATCH';
  dbBefore?: any;
  kisAfter?: any;
  reason?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;

    // 1) 현재 DB Position 조회
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
          source: true,
          openedAt: true,
          updatedAt: true,
        },
      });
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      return NextResponse.json(
        { success: false, error: 'Position DB 조회 실패', dbError: msg },
        { status: 500 }
      );
    }

    // 2) KIS 잔고 조회
    const config = await getOrCreateKisConfigFromEnv();
    if (!config) {
      return NextResponse.json(
        { success: false, error: 'KIS 설정 없음 — KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NO 환경변수 확인' },
        { status: 400 }
      );
    }

    let kisBalance: any;
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
      return NextResponse.json(
        { success: false, error: 'KIS 잔고 조회 실패', kisError: e instanceof Error ? e.message : String(e) },
        { status: 500 }
      );
    }

    const kisPositions: any[] = kisBalance?.positions ?? [];
    const kisByCode = new Map(kisPositions.map(p => [p.stockCode, p]));

    // 3) 동기화 계획 수립
    const plan: ResyncPlan[] = [];

    // 3a) DB에 있는데 KIS에 없는 포지션 → DELETE
    for (const dbPos of dbPositions) {
      const kisPos = kisByCode.get(dbPos.stockCode);
      if (!kisPos) {
        plan.push({
          stockCode: dbPos.stockCode,
          stockName: dbPos.stockName,
          action: 'DELETE',
          dbBefore: {
            id: dbPos.id,
            avgPrice: dbPos.avgPrice,
            quantity: dbPos.quantity,
            currentPrice: dbPos.currentPrice,
            strategy: dbPos.strategy,
            source: dbPos.source,
          },
          reason: 'KIS 잔고에 없음 — 전량 매도 또는 미체결',
        });
      }
    }

    // 3b) KIS에 있는 포지션 → CREATE or UPDATE (단가 sanity check)
    for (const kisPos of kisPositions) {
      const dbPos = dbPositions.find(p => p.stockCode === kisPos.stockCode);
      const positionId = `DOMESTIC-KR-${kisPos.stockCode}`;

      // 단가 sanity check
      if (!kisPos.avgPrice || kisPos.avgPrice <= 0) {
        plan.push({
          stockCode: kisPos.stockCode,
          stockName: kisPos.stockName,
          action: 'SKIP_MISMATCH',
          kisAfter: {
            avgPrice: kisPos.avgPrice,
            quantity: kisPos.quantity,
            rawAvgPriceField: kisPos.rawAvgPriceField,
            rawAvgPrice: kisPos.rawAvgPrice,
            purchaseAmount: kisPos.purchaseAmount,
          },
          reason: `avgPrice 유효하지 않음 (${kisPos.avgPrice})`,
        });
        continue;
      }
      if (kisPos.priceMismatch === true) {
        plan.push({
          stockCode: kisPos.stockCode,
          stockName: kisPos.stockName,
          action: 'SKIP_MISMATCH',
          kisAfter: {
            avgPrice: kisPos.avgPrice,
            quantity: kisPos.quantity,
            calculatedAvgPrice: kisPos.calculatedAvgPrice,
            purchaseAmount: kisPos.purchaseAmount,
            mismatchReason: kisPos.mismatchReason,
          },
          reason: `단가 괴리: ${kisPos.mismatchReason}`,
        });
        continue;
      }

      const kisData = {
        id: positionId,
        stockCode: kisPos.stockCode,
        stockName: kisPos.stockName,
        quantity: kisPos.quantity,
        avgPrice: kisPos.avgPrice,
        currentPrice: kisPos.currentPrice,
        profitLoss: kisPos.profitLoss,
        profitRate: kisPos.profitRate,
        source: kisPos.source || 'KIS_BALANCE',
        purchaseAmount: kisPos.purchaseAmount,
        rawAvgPriceField: kisPos.rawAvgPriceField,
      };

      if (!dbPos) {
        plan.push({
          stockCode: kisPos.stockCode,
          stockName: kisPos.stockName,
          action: 'CREATE',
          kisAfter: kisData,
          reason: 'KIS 잔고에 있는데 DB에 없음 — 신규 생성',
        });
      } else {
        plan.push({
          stockCode: kisPos.stockCode,
          stockName: kisPos.stockName,
          action: 'UPDATE',
          dbBefore: {
            id: dbPos.id,
            avgPrice: dbPos.avgPrice,
            quantity: dbPos.quantity,
            currentPrice: dbPos.currentPrice,
            source: dbPos.source,
          },
          kisAfter: kisData,
          reason: 'KIS 잔고 기준으로 avgPrice/quantity/currentPrice 갱신',
        });
      }
    }

    // 4) dryRun이면 계획만 반환
    if (dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        plan,
        summary: {
          total: plan.length,
          create: plan.filter(p => p.action === 'CREATE').length,
          update: plan.filter(p => p.action === 'UPDATE').length,
          delete: plan.filter(p => p.action === 'DELETE').length,
          skip: plan.filter(p => p.action === 'SKIP_MISMATCH').length,
        },
      });
    }

    // 5) 실제 DB 반영 — 직접 Prisma 사용 (db.ts Proxy 우회)
    const results = {
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const item of plan) {
      try {
        if (item.action === 'DELETE') {
          // 로그 먼저 남기고 삭제
          console.log('[Position Resync] DELETE (사전 로그)', {
            stockCode: item.stockCode,
            stockName: item.stockName,
            dbBefore: item.dbBefore,
          });
          await prisma.position.deleteMany({ where: { stockCode: item.stockCode, market: 'DOMESTIC' } });
          results.deleted++;
        } else if (item.action === 'CREATE') {
          console.log('[Position Resync] CREATE', {
            stockCode: item.stockCode,
            kisAfter: item.kisAfter,
          });
          await prisma.position.create({
            data: {
              id: item.kisAfter.id,
              stockCode: item.kisAfter.stockCode,
              stockName: item.kisAfter.stockName,
              quantity: item.kisAfter.quantity,
              avgPrice: item.kisAfter.avgPrice,
              currentPrice: item.kisAfter.currentPrice,
              profitLoss: item.kisAfter.profitLoss,
              profitRate: item.kisAfter.profitRate,
              strategy: 'MANUAL',
              market: 'DOMESTIC',
              currency: 'KRW',
              source: item.kisAfter.source,
            },
          });
          results.created++;
        } else if (item.action === 'UPDATE') {
          console.log('[Position Resync] UPDATE', {
            stockCode: item.stockCode,
            dbBefore: item.dbBefore,
            kisAfter: item.kisAfter,
          });
          await prisma.position.updateMany({
            where: { stockCode: item.stockCode, market: 'DOMESTIC' },
            data: {
              stockName: item.kisAfter.stockName,
              quantity: item.kisAfter.quantity,
              avgPrice: item.kisAfter.avgPrice,
              currentPrice: item.kisAfter.currentPrice,
              profitLoss: item.kisAfter.profitLoss,
              profitRate: item.kisAfter.profitRate,
              source: item.kisAfter.source,
            },
          });
          results.updated++;
        } else if (item.action === 'SKIP_MISMATCH') {
          console.warn('[Position Resync] SKIP_MISMATCH', {
            stockCode: item.stockCode,
            reason: item.reason,
            kisAfter: item.kisAfter,
          });
          results.skipped++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.errors.push(`${item.stockCode} (${item.action}): ${msg}`);
        console.error('[Position Resync] ERROR', { stockCode: item.stockCode, action: item.action, error: msg });
      }
    }

    return NextResponse.json({
      success: true,
      dryRun: false,
      summary: {
        total: plan.length,
        created: results.created,
        updated: results.updated,
        deleted: results.deleted,
        skipped: results.skipped,
        errors: results.errors.length,
      },
      results,
      plan,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `재동기화 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    description: 'DB Position을 KIS 잔고 기준으로 재동기화',
    usage: {
      method: 'POST',
      body: {
        dryRun: 'boolean (선택, 기본 false) — true면 변경 예정 내역만 반환',
      },
    },
    safety: '실행 전 dbBefore와 kisAfter 값을 로그로 남깁니다. dryRun=true로 먼저 변경 내역을 확인하세요.',
  });
}
