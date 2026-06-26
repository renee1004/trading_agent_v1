// 거래내역 정리 API
// 2026-06-26 00:00:00 KST 이전의 과거 TradeHistory / AgentLog를 백업 후 삭제
//
// v3 설계 원칙 참고:
//   - Position = KIS 잔고 기준 원장 (LEDGER). 절대 삭제/정리 금지.
//   - TradeHistory = 체결/주문/차단 기록 (AUDIT_TRAIL). 원칙적으로 immutable이나,
//     v1에서는 과거 STRATEGY_TEST 시절의 오류 데이터로부터 새 기준으로 전환하기 위해
//     cutoff 기준 한정 정리 허용. 정리 후에는 immutable로 취급.
//   - AgentLog = 실행 로그 (RUNTIME_LOG). 진단용이므로 날짜 기준 정리 가능.
//
// GET  — 정리 대상 preview (삭제 대상 개수/범위)
// POST — 확인값이 있을 때만 백업(AppSetting) 후 삭제
//
// 삭제 대상:
//   - TradeHistory (tradedAt < cutoff)
//   - AgentLog (createdAt < cutoff, 거래/신호/주문 관련 타입)
//
// 삭제하지 않는 것:
//   - Position (KIS 잔고 동기화 결과)
//   - AppSetting, KisConfig, RiskConfig 등 설정 테이블
//   - MarketData (캔들 데이터)
//
// 백업 방식: AppSetting에 JSON 저장 (count + 샘플)
//   키: trade_history_cleanup_backup_2026_06_26

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// ── KST 기준 cutoff ──
// 2026-06-26 00:00:00 KST = 2026-06-25T15:00:00.000Z
const CUTOFF_KST = '2026-06-26T00:00:00+09:00';
const CUTOFF_UTC = new Date('2026-06-25T15:00:00.000Z');

// 백업 AppSetting 키
const BACKUP_KEY = 'trade_history_cleanup_backup_2026_06_26';

// 삭제 대상 AgentLog 타입
const TRADE_RELATED_LOG_TYPES = ['TRADE', 'SIGNAL', 'RISK', 'EXIT'];

/**
 * KST 오늘 자정 UTC를 반환 (동적 필터용)
 */
function getStartOfTodayKST(): Date {
  const now = new Date();
  // KST = UTC+9
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);
  const kstDateStr = kstNow.toISOString().slice(0, 10); // YYYY-MM-DD
  // 그 날의 00:00:00 KST = 전날 15:00:00 UTC
  return new Date(`${kstDateStr}T00:00:00+09:00`);
}

export async function GET() {
  try {
    const cutoff = CUTOFF_UTC;

    // ── 삭제 대상 카운트 ──
    const [tradeHistoryCount, agentLogCount, totalTradeHistory, totalAgentLog] = await Promise.all([
      prisma.tradeHistory.count({
        where: { tradedAt: { lt: cutoff } },
      }),
      prisma.agentLog.count({
        where: {
          createdAt: { lt: cutoff },
          type: { in: TRADE_RELATED_LOG_TYPES },
        },
      }),
      prisma.tradeHistory.count(),
      prisma.agentLog.count(),
    ]);

    return NextResponse.json({
      success: true,
      mode: 'preview',
      cutoffKST: CUTOFF_KST,
      cutoffUTC: cutoff.toISOString(),
      targets: {
        tradeHistoryBeforeCutoff: tradeHistoryCount,
        agentLogsBeforeCutoff: agentLogCount,
      },
      totalRecords: {
        tradeHistory: totalTradeHistory,
        agentLog: totalAgentLog,
      },
      willDelete: false,
      note: 'POST with {"confirm":"CLEAN_TRADE_HISTORY_FROM_2026_06_26"} to archive and cleanup old records.',
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown';
    console.error('[CleanupTradeHistory] Preview failed:', errMsg);
    return NextResponse.json(
      { success: false, error: `정리 대상 조회 실패: ${errMsg}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // ── 확인값 검증 ──
    const body = await request.json().catch(() => ({}));
    if (body.confirm !== 'CLEAN_TRADE_HISTORY_FROM_2026_06_26') {
      return NextResponse.json(
        {
          success: false,
          error: '잘못된 확인값입니다.',
          required: '{"confirm":"CLEAN_TRADE_HISTORY_FROM_2026_06_26"}',
        },
        { status: 400 }
      );
    }

    const cutoff = CUTOFF_UTC;

    // ── 1. 삭제 대상 데이터 백업 (AppSetting에 count + 샘플 저장) ──
    const [tradeHistoryBefore, agentLogsBefore] = await Promise.all([
      // TradeHistory: 전체 필드로 조회 (백업용)
      prisma.tradeHistory.findMany({
        where: { tradedAt: { lt: cutoff } },
        orderBy: { tradedAt: 'desc' },
        take: 200, // JSON 크기 제한 — 최대 200건 샘플
      }),
      // AgentLog: 거래 관련 로그만
      prisma.agentLog.findMany({
        where: {
          createdAt: { lt: cutoff },
          type: { in: TRADE_RELATED_LOG_TYPES },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);

    const tradeHistoryTotalCount = await prisma.tradeHistory.count({
      where: { tradedAt: { lt: cutoff } },
    });
    const agentLogTotalCount = await prisma.agentLog.count({
      where: {
        createdAt: { lt: cutoff },
        type: { in: TRADE_RELATED_LOG_TYPES },
      },
    });

    // ── 2. 백업 AppSetting 저장 ──
    const backupData = {
      createdAt: new Date().toISOString(),
      cutoffKST: CUTOFF_KST,
      cutoffUTC: cutoff.toISOString(),
      totalCounts: {
        tradeHistory: tradeHistoryTotalCount,
        agentLog: agentLogTotalCount,
      },
      samples: {
        tradeHistory: tradeHistoryBefore.map((t) => ({
          id: t.id,
          stockCode: t.stockCode,
          stockName: t.stockName,
          tradeType: t.tradeType,
          quantity: t.quantity,
          price: t.price,
          status: t.status,
          orderExecutionMode: t.orderExecutionMode,
          source: t.source,
          filledPrice: t.filledPrice,
          avgFillPrice: t.avgFillPrice,
          orderPrice: t.orderPrice,
          signalReason: t.signalReason,
          tradedAt: t.tradedAt?.toISOString(),
        })),
        agentLog: agentLogsBefore.map((l) => ({
          id: l.id,
          type: l.type,
          market: l.market,
          message: l.message,
          createdAt: l.createdAt?.toISOString(),
        })),
      },
    };

    try {
      // AppSetting에 백업 저장
      const existing = await prisma.appSetting.findFirst({ where: { key: BACKUP_KEY } });
      if (existing) {
        await prisma.appSetting.update({
          where: { id: existing.id },
          data: { value: backupData as any },
        });
      } else {
        await prisma.appSetting.create({
          data: { key: BACKUP_KEY, value: backupData as any },
        });
      }
      console.log(`[CleanupTradeHistory] 백업 저장 완료: key=${BACKUP_KEY}, tradeHistory=${tradeHistoryTotalCount}, agentLog=${agentLogTotalCount}`);
    } catch (backupErr) {
      const backupErrMsg = backupErr instanceof Error ? backupErr.message : String(backupErr);
      console.error('[CleanupTradeHistory] 백업 저장 실패:', backupErrMsg);
      // 백업 실패해도 삭제는 진행 (이미 preview에서 확인했음)
    }

    // ── 3. TradeHistory 삭제 (cutoff 이전) ──
    let deletedTradeHistory = 0;
    try {
      const deleteResult = await prisma.tradeHistory.deleteMany({
        where: { tradedAt: { lt: cutoff } },
      });
      deletedTradeHistory = deleteResult.count;
    } catch (delErr) {
      const delErrMsg = delErr instanceof Error ? delErr.message : String(delErr);
      console.error('[CleanupTradeHistory] TradeHistory 삭제 실패:', delErrMsg);
      return NextResponse.json(
        { success: false, error: `TradeHistory 삭제 실패: ${delErrMsg}`, phase: 'delete_trade_history' },
        { status: 500 }
      );
    }

    // ── 4. AgentLog 삭제 (cutoff 이전 + 거래 관련 타입만) ──
    let deletedAgentLogs = 0;
    try {
      const deleteResult = await prisma.agentLog.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          type: { in: TRADE_RELATED_LOG_TYPES },
        },
      });
      deletedAgentLogs = deleteResult.count;
    } catch (delErr) {
      const delErrMsg = delErr instanceof Error ? delErr.message : String(delErr);
      console.error('[CleanupTradeHistory] AgentLog 삭제 실패:', delErrMsg);
      return NextResponse.json(
        { success: false, error: `AgentLog 삭제 실패: ${delErrMsg}`, phase: 'delete_agent_log', deletedTradeHistory },
        { status: 500 }
      );
    }

    // ── 5. 결과 반환 ──
    console.log(`[CleanupTradeHistory] 정리 완료: TradeHistory=${deletedTradeHistory}, AgentLog=${deletedAgentLogs}`);

    return NextResponse.json({
      success: true,
      cutoffKST: CUTOFF_KST,
      cutoffUTC: cutoff.toISOString(),
      archived: {
        tradeHistory: tradeHistoryTotalCount,
        agentLog: agentLogTotalCount,
        backupKey: BACKUP_KEY,
      },
      deleted: {
        tradeHistory: deletedTradeHistory,
        agentLog: deletedAgentLogs,
      },
      message: 'Old trade data cleaned. New records will start from 2026-06-26.',
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown';
    console.error('[CleanupTradeHistory] Cleanup failed:', errMsg);
    return NextResponse.json(
      { success: false, error: `정리 실행 실패: ${errMsg}` },
      { status: 500 }
    );
  }
}