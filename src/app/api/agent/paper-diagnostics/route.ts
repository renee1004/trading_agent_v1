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
    msg.includes('KIS') || msg.includes('토큰') || msg.includes('잔고') ||
    msg.includes('포지션') || msg.includes('현재가') || msg.includes('캔들')
  ) {
    categories.push('kisRelated');
  }

  return categories.length > 0 ? categories : [];
}

function parseDetails(details: string | null | undefined): unknown {
  if (!details) return null;
  if (typeof details !== 'string') return details;
  try {
    return JSON.parse(details);
  } catch {
    return details;
  }
}

// ─── blockers 생성 ────────────────────────────────────────────────

function buildBlockers(
  agentStatus: ReturnType<typeof getAgentStatus>,
  runtimeDecision: ReturnType<typeof computeRuntimeDecision>,
  settings: ReturnType<typeof getEffectiveTradingSettings> extends Promise<infer R> ? R extends { settings: infer S } ? S : never : never,
): string[] {
  const blockers: string[] = [];

  if (!agentStatus.isRunning) {
    blockers.push('에이전트가 실행 중이 아닙니다.');
  }

  const { settings: s } = { settings }; // TypeScript 타입 추론용
  if (!settings.autoAnalysisEnabled) {
    blockers.push('자동 분석 설정이 꺼져 있습니다.');
  }
  if (!runtimeDecision.canRunAnalysisNow && runtimeDecision.analysisBlockedReason) {
    blockers.push(`현재 분석 차단: ${runtimeDecision.analysisBlockedReason}`);
  }
  if (!runtimeDecision.canPlaceDomesticOrderNow && runtimeDecision.domesticOrderBlockedReason) {
    blockers.push(`현재 국내 주문 차단: ${runtimeDecision.domesticOrderBlockedReason}`);
  }
  if (!runtimeDecision.canPlaceOverseasOrderNow && runtimeDecision.overseasOrderBlockedReason) {
    blockers.push(`현재 해외 주문 차단: ${runtimeDecision.overseasOrderBlockedReason}`);
  }
  if (!settings.autoDomesticOrderEnabled) {
    blockers.push('국내 자동 주문 비활성화');
  }
  if (!settings.enableOverseasOrder) {
    blockers.push('해외 자동 주문 비활성화');
  }
  if (settings.killSwitchEnabled) {
    blockers.push('killSwitchEnabled=true');
  }

  return blockers;
}

// ─── nextCheck 문구 생성 ──────────────────────────────────────────

function buildNextCheck(
  logCounts: Record<LogCategory, number>,
  hasSignalLogs: boolean,
): string[] {
  const checks: string[] = [];

  if (logCounts.error > 0) {
    checks.push('오류 로그가 있습니다. error 샘플의 details를 먼저 확인하세요.');
  }
  if (logCounts.risk > 0) {
    checks.push('차단 로그가 있습니다. risk 샘플에서 차단 사유를 확인하세요.');
  }
  if (logCounts.trade > 0) {
    checks.push('거래 관련 로그가 있습니다. 거래내역과 포지션 반영 여부를 확인하세요.');
  }
  if (!hasSignalLogs) {
    checks.push('신호 로그가 없습니다. 관심종목, 캔들 데이터, KIS 연결 상태를 확인하세요.');
  }

  if (checks.length === 0) {
    checks.push('모든 상태가 정상입니다. 다음 사이클 결과를 기다리세요.');
  }

  return checks;
}

// ─── GET 핸들러 ───────────────────────────────────────────────────

export async function GET() {
  try {
    // 1. 에이전트 상태
    const agentStatus = getAgentStatus();
    const recentMemoryLogs = getAgentLogs(30);

    // 2. 스케줄러 상태
    const schedulerStatus = await getSchedulerStatus();

    // 3. 실제 적용 설정
    const { settings: effectiveSettings, source: settingsSource, sources: settingsSources } = await getEffectiveTradingSettings();

    // 4. 런타임 판단
    const runtimeDecision = computeRuntimeDecision(effectiveSettings);

    // 5. DB 로그 조회 (최근 30개)
    let dbLogs: Array<{
      id: string;
      type: string;
      market: string;
      message: string;
      details: string | null;
      createdAt: string;
    }> = [];
    try {
      const logs = await db.agentLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      dbLogs = logs.map(l => ({
        id: l.id,
        type: l.type,
        market: l.market,
        message: l.message,
        details: l.details,
        createdAt: l.createdAt.toISOString(),
      }));
    } catch {
      // DB 로그 조회 실패 시 메모리 로그만 사용
    }

    // 6. 메모리 + DB 로그 병합 (중복 제거)
    const memoryLogKeys = new Set(recentMemoryLogs.map(l => l.message + l.type));
    const mergedLogs: ClassifiedLog[] = [
      ...recentMemoryLogs.map(log => ({
        id: log.id,
        timestamp: log.timestamp.toISOString(),
        type: log.type,
        market: log.market,
        message: log.message,
        details: log.details || null,
      })),
      ...dbLogs.filter(l => !memoryLogKeys.has(l.message + l.type)).map(l => ({
        id: l.id,
        timestamp: l.createdAt,
        type: l.type,
        market: l.market,
        message: l.message,
        details: parseDetails(l.details),
      })),
    ].slice(0, 50);

    // 7. 로그 분류
    const logCounts: Record<LogCategory, number> = {
      signal: 0,
      risk: 0,
      trade: 0,
      error: 0,
      kisRelated: 0,
    };
    const logSamples: Record<LogCategory, ClassifiedLog[]> = {
      signal: [],
      risk: [],
      trade: [],
      error: [],
      kisRelated: [],
    };

    for (const log of mergedLogs) {
      const categories = classifyLog(log);
      for (const cat of categories) {
        logCounts[cat]++;
        if (logSamples[cat].length < 3) {
          logSamples[cat].push({
            ...log,
            details: parseDetails(typeof log.details === 'string' ? log.details : JSON.stringify(log.details)),
          });
        }
      }
    }

    const totalClassified = mergedLogs.length;

    // 8. blockers
    const blockers = buildBlockers(agentStatus, runtimeDecision, effectiveSettings);

    // 9. nextCheck
    const nextCheck = buildNextCheck(logCounts, logCounts.signal > 0);

    // 10. 응답 구성
    return NextResponse.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        endpoint: '/api/agent/paper-diagnostics',
        readOnly: true,

        agent: {
          isRunning: agentStatus.isRunning,
          currentSessionId: agentStatus.currentSessionId,
          lastCycleTime: agentStatus.lastCycleTime?.toISOString() || null,
          totalCycles: agentStatus.totalCycles,
          totalTrades: agentStatus.totalTrades,
          lastCycleSummary: agentStatus.lastCycleResult ? {
            stocksAnalyzed: agentStatus.lastCycleResult.stocksAnalyzed,
            signalsGenerated: agentStatus.lastCycleResult.signalsGenerated,
            ordersPlaced: agentStatus.lastCycleResult.ordersPlaced,
            positionsMonitored: agentStatus.lastCycleResult.positionsMonitored,
            exitsExecuted: agentStatus.lastCycleResult.exitsExecuted,
            domesticSuccess: agentStatus.lastCycleResult.domesticSuccess,
            domesticFailed: agentStatus.lastCycleResult.domesticFailed,
            overseasSuccess: agentStatus.lastCycleResult.overseasSuccess,
            overseasFailed: agentStatus.lastCycleResult.overseasFailed,
            zeroAnalysisReason: agentStatus.lastCycleResult.zeroAnalysisReason,
          } : null,
        },

        scheduler: {
          isSchedulerRunning: schedulerStatus.isSchedulerRunning,
          schedulerMode: schedulerStatus.schedulerMode,
          isCycleRunning: schedulerStatus.isCycleRunning,
          errorCount: schedulerStatus.errorCount,
          nextCycleAt: schedulerStatus.nextCycleAt?.toISOString() || null,
          currentKST: schedulerStatus.currentKST,
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
        logSummary: {
          total: totalClassified,
          signal: logCounts.signal,
          risk: logCounts.risk,
          trade: logCounts.trade,
          error: logCounts.error,
          kisRelated: logCounts.kisRelated,
          samples: {
            signal: logSamples.signal,
            risk: logSamples.risk,
            trade: logSamples.trade,
            error: logSamples.error,
            kisRelated: logSamples.kisRelated,
          },
        },
        nextCheck,
        recentLogs: mergedLogs.slice(0, 20),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `진단 조회 실패: ${error instanceof Error ? error.message : 'Unknown'}` },
      { status: 500 }
    );
  }
}
