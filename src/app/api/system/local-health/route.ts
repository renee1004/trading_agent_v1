// 로컬 개발/검증 환경 상태 진단 API
// 민감정보 노출 금지, 가벼운 쿼리만 사용

import { NextResponse } from 'next/server';
import { getEnvDiagnostics, getGitVersionInfo } from '@/lib/env-diagnostics';
import { getKisEnvDiagnostics } from '@/lib/kis-env-diagnostics';
import { getKisLastError } from '@/lib/kis-api';
import { getEffectiveTradingSettings, computeRuntimeDecision } from '@/lib/effective-settings';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const env = getEnvDiagnostics();
    const git = await getGitVersionInfo();

    // DB 연결 확인 (가벼운 쿼리)
    let dbConnected = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbConnected = true;
    } catch {
      dbConnected = false;
    }

    // 설정 로드 (안전 보정 포함)
    let effectiveSettings: Awaited<ReturnType<typeof getEffectiveTradingSettings>>['settings'] | null = null;
    let runtimeDecision: ReturnType<typeof computeRuntimeDecision> | null = null;
    let safetyMode: string = 'UNKNOWN';
    try {
      const result = await getEffectiveTradingSettings();
      effectiveSettings = result.settings;
      runtimeDecision = computeRuntimeDecision(result.settings);
      safetyMode = result._safety.allowStrategyTestOrder ? 'TEST_ALLOWED' : 'SAFE_LOCKED';
    } catch {
      // 설정 로드 실패 시 기본값
    }

    // KIS 진단 (공통 판정 함수)
    const kisDiag = getKisEnvDiagnostics();
    const kisLastError = getKisLastError();

    return NextResponse.json({
      success: true,
      runtime: git.gitCommitSha && !process.env.RAILWAY_SERVICE_ID ? 'local' : process.env.RAILWAY_SERVICE_ID ? 'railway' : 'unknown',
      database: { connected: dbConnected },
      kis: {
        configured: kisDiag.kisConfigured,
        baseUrl: kisDiag.baseUrlType,
        missingKeys: kisDiag.missingKeys,
        allowRealFallback: kisDiag.allowRealFallback,
        isDemo: kisDiag.isDemo,
        ...(kisLastError ? {
          lastError: {
            phase: kisLastError.phase,
            stockCode: kisLastError.stockCode ?? null,
            endpointPath: kisLastError.endpointPath ?? null,
            trId: kisLastError.trId ?? null,
            server: kisLastError.server,
            httpStatus: kisLastError.httpStatus,
            rt_cd: kisLastError.rt_cd ?? null,
            msg_cd: kisLastError.msg_cd ?? null,
            msg1: kisLastError.msg1 ?? null,
            probableCauses: kisLastError.probableCauses,
            timestamp: kisLastError.timestamp,
          },
        } : {}),
      },
      safety: {
        effectiveSafetyMode: safetyMode,
        canPlaceDomesticOrderNow: runtimeDecision?.canPlaceDomesticOrderNow ?? false,
        killSwitchEnabled: effectiveSettings?.killSwitchEnabled ?? true,
        autoDomesticOrderEnabled: effectiveSettings?.autoDomesticOrderEnabled ?? false,
        orderExecutionMode: effectiveSettings?.orderExecutionMode ?? 'DRY_RUN',
        tradingMode: effectiveSettings?.tradingMode ?? 'DEMO',
        strategyAggressiveness: effectiveSettings?.strategyAggressiveness ?? 'CONSERVATIVE',
      },
      version: {
        gitCommitSha: git.gitCommitSha,
        gitBranch: git.gitBranch,
      },
      envDiagnostics: env,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown';
    return NextResponse.json(
      { success: false, error: `Health check failed: ${errMsg}` },
      { status: 500 }
    );
  }
}
