// 모의투자 진단 읽기 전용 API
// 주문/리스크/KIS 로직은 변경하지 않고, 현재 상태만 읽어서 반환
// GET /api/agent/paper-diagnostics

import { NextResponse } from 'next/server';
import { getAgentStatus, getAgentLogs } from '@/lib/trading-agent';
import { getSchedulerStatus } from '@/lib/agent-scheduler';
import { getEffectiveTradingSettings, computeRuntimeDecision } from '@/lib/effective-settings';
import { getCurrentKSTString } from '@/lib/market-hours';
import { db } from '@/lib/db';

// ─── 로그 분류 유틸리티 ──────────────────────────────────────────

interface ClassifiedLog {
  id: string;
  timestamp: string;
  type: string;
  market: string;
  message: string;
  details: unknown;
}

type LogCategory = 'signal' | 'risk' | 'trade' | 'error' | 'kisRelated';

function classifyLog(log: { type: string; message: string }): LogCategory[] {
  const categories: LogCategory[] = [];
  const msg = log.message;

  if (log.type === 'SIGNAL' || msg.includes('신호') || msg.includes('AI 검증')) {
    categories.push('signal');
  }
  if (log.type === 'RISK' || msg.includes('차단') || msg.includes('리스크')) {
    categories.push('risk');
  }
  if (log.type === 'TRADE' || msg.includes('주문 접수') || msg.includes('체결') || msg.includes('청산')) {
    categories.push('trade');
  }
  if (log.type === 'ERROR') {
    categories.push('error');
  }
  if (
    msg.includes('KIS') ||
    msg.includes('토큰') ||
    msg.includes('잔고') ||
    msg.includes('포지션') ||
    msg.includes('현재가') ||
    msg.includes('캔들')
  ) {
    categories.push('kisRelated');
  }

  return categories;
}

function parseDetails(details: string | null): unknown {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return details;
  }
}

function summarizeLogs(logs: ClassifiedLog[]) {
  const summary = {
    total: logs.length,
    signal: 0,
    risk: 0,
    trade: 0,
    error: 0,
    kisRelated: 0,
    samples: {
      signal: [] as ClassifiedLog[],
      risk: [] as ClassifiedLog[],
      trade: [] as ClassifiedLog[],
      error: [] as ClassifiedLog[],
      kisRelated: [] as ClassifiedLog[],
    },
  };

  for (const log of logs) {
    const categories = classifyLog(log);
    for (const category of categories) {
      summary[category]++;
      if (summary.samples[category].length < 10) {
        summary.samples[category].push(log);
      }
    }
  }

  return summary;
}

function buildNextCheck(logSummary: ReturnType<typeof summarizeLogs>): string[] {
  const checks: string[] = [];

  if (logSummary.error > 0) {
    checks.push('오류 로그가 있습니다. error 샘플의 details를 먼저 확인하세요.');
  }
  if (logSummary.risk > 0) {
    checks.push('차단 로그가 있습니다. risk 샘플에서 차단 사유를 확인하세요.');
  }
  if (logSummary.trade > 0) {
    checks.push('거래 관련 로그가 있습니다. 거래내역과 포지션 반영 여부를 확인하세요.');
  }
  if (logSummary.signal === 0) {
    checks.push('신호 로그가 없습니다. 관심종목, 캔들 데이터, KIS 연결 상태를 확인하세요.');
  }
  if (logSummary.kisRelated > 0) {
    checks.push('KIS 관련 로그가 있습니다. 토큰, 잔고, 포지션, 캔들 조회 메시지를 확인하세요.');
  }

  if (checks.length === 0) {
    checks.push('최근 로그에 명확한 오류/차단은 없습니다. 다음 사이클 실행 후 다시 확인하세요.');
  }

  return checks;
}

// ─── API 핸들러 ────────────────────────────────────────────────

export async function GET() {
  try {
    const agentStatus = getAgentStatus();
    const memoryLogs = getAgentLogs(50);
    const schedulerStatus = await getSchedulerStatus();

    const {
      settings: effectiveSettings,
      source: settingsSource,
      sources: settingsSources,
    } = await getEffectiveTradingSettings();

    const runtimeDecision = computeRuntimeDecision(effectiveSettings);

    // DB 영속 로그 조회
    let dbLogs: ClassifiedLog[] = [];
    try {
      const rows = await db.agentLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 80,
      });

      dbLogs = rows.map(row => ({
        id: row.id,
        timestamp: row.createdAt.toISOString(),
        type: row.type,
        market: row.market,
        message: row.message,
        details: parseDetails(row.details),
      }));
    } catch {
      dbLogs = [];
    }

    const memoryClassifiedLogs: ClassifiedLog[] = memoryLogs.map(log => ({
      id: log.id,
      timestamp: log.timestamp.toISOString(),
      type: log.type,
      market: log.market,
      message: log.message,
      details: log.details ?? null,
    }));

    // 메모리 로그 + DB 로그 병합, 중복 제거
    const seen = new Set<string>();
    const mergedLogs = [...memoryClassifiedLogs, ...dbLogs]
      .filter(log => {
        const key = `${log.type}:${log.market}:${log.message}:${log.timestamp}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 100);

    const lastCycleSummary = agentStatus.lastCycleResult
      ? {
          stocksAnalyzed: agentStatus.lastCycleResult.stocksAnalyzed,
          signalsGenerated: agentStatus.lastCycleResult.signalsGenerated,
          ordersPlaced: agentStatus.lastCycleResult.ordersPlaced,
          positionsMonitored: agentStatus.lastCycleResult.positionsMonitored,
          exitsExecuted: agentStatus.lastCycleResult.exitsExecuted,
          durationMs:
            agentStatus.lastCycleResult.endTime.getTime() -
            agentStatus.lastCycleResult.startTime.getTime(),
          domesticSuccess: agentStatus.lastCycleResult.domesticSuccess,
          domesticFailed: agentStatus.lastCycleResult.domesticFailed,
          overseasSuccess: agentStatus.lastCycleResult.overseasSuccess,
          overseasFailed: agentStatus.lastCycleResult.overseasFailed,
          zeroAnalysisReason: agentStatus.lastCycleResult.zeroAnalysisReason,
          errors: agentStatus.lastCycleResult.errors,
        }
      : null;

    // 현재 모의투자 테스트를 막을 수 있는 요인 정리
    const blockers: string[] = [];

    if (!agentStatus.isRunning) {
      blockers.push('에이전트가 실행 중이 아닙니다.');
    }
    if (!effectiveSettings.autoAnalysisEnabled) {
      blockers.push('자동 분석 설정이 꺼져 있습니다.');
    }
    if (!runtimeDecision.canRunAnalysisNow) {
      blockers.push(`현재 분석 차단: ${runtimeDecision.analysisBlockedReason || '이유 없음'}`);
    }
    if (!runtimeDecision.canPlaceDomesticOrderNow) {
      blockers.push(`현재 국내 주문 차단: ${runtimeDecision.domesticOrderBlockedReason || '이유 없음'}`);
    }
    if (!runtimeDecision.canPlaceOverseasOrderNow) {
      blockers.push(`현재 해외 주문 차단: ${runtimeDecision.overseasOrderBlockedReason || '이유 없음'}`);
    }
    if (!effectiveSettings.autoDomesticOrderEnabled) {
      blockers.push('국내 자동 주문 비활성화');
    }
    if (!effectiveSettings.enableOverseasOrder) {
      blockers.push('해외 자동 주문 비활성화');
    }
    if (effectiveSettings.killSwitchEnabled) {
      blockers.push('killSwitchEnabled=true');
    }

    const logSummary = summarizeLogs(mergedLogs);
    const nextCheck = buildNextCheck(logSummary);

    return NextResponse.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        endpoint: '/api/agent/paper-diagnostics',
        readOnly: true,

        agent: {
          isRunning: agentStatus.isRunning,
          currentSessionId: agentStatus.currentSessionId,
          lastCycleTime: agentStatus.lastCycleTime?.toISOString() ?? null,
          totalCycles: agentStatus.totalCycles,
          totalTrades: agentStatus.totalTrades,
          lastCycleSummary,
        },

        scheduler: {
          isSchedulerRunning: schedulerStatus.isSchedulerRunning,
          schedulerMode: schedulerStatus.schedulerMode,
          isCycleRunning: schedulerStatus.isCycleRunning,
          errorCount: schedulerStatus.errorCount,
          nextCycleAt: schedulerStatus.nextCycleAt?.toISOString() ?? null,
          currentKST: getCurrentKSTString(),
          domesticSession: schedulerStatus.domesticSession,
          isMarketOpen: schedulerStatus.isMarketOpen,
        },

        settings: {
          source: settingsSource,
          sources: settingsSources,
          autoAnalysisEnabled: effectiveSettings.autoAnalysisEnabled,
          runAnalysisOnlyDuringMarketHours: effectiveSettings.runAnalysisOnlyDuringMarketHours,
          autoDomesticOrderEnabled: effectiveSettings.autoDomesticOrderEnabled,
          enableOverseasAnalysis: effectiveSettings.enableOverseasAnalysis,
          enableOverseasOrder: effectiveSettings.enableOverseasOrder,
          allowAfterHoursTrading: effectiveSettings.allowAfterHoursTrading,
          tradeOnlyMarketHours: effectiveSettings.tradeOnlyMarketHours,
          tradingMode: effectiveSettings.tradingMode,
          orderExecutionMode: effectiveSettings.orderExecutionMode,
          killSwitchEnabled: effectiveSettings.killSwitchEnabled,
        },

        runtime: {
          canRunAnalysisNow: runtimeDecision.canRunAnalysisNow,
          canPlaceDomesticOrderNow: runtimeDecision.canPlaceDomesticOrderNow,
          canPlaceOverseasOrderNow: runtimeDecision.canPlaceOverseasOrderNow,
          analysisBlockedReason: runtimeDecision.analysisBlockedReason,
          domesticOrderBlockedReason: runtimeDecision.domesticOrderBlockedReason,
          overseasOrderBlockedReason: runtimeDecision.overseasOrderBlockedReason,
        },

        blockers,
        logSummary,
        nextCheck,
        recentLogs: mergedLogs.slice(0, 30),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: `모의투자 진단 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}`,
      },
      { status: 500 }
    );
  }
}
