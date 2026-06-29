// 로컬 개발/검증 환경 상태 진단 API
// 민감정보 노출 금지, 가벼운 쿼리만 사용

import { NextResponse } from 'next/server';
import { getEnvDiagnostics, getGitVersionInfo } from '@/lib/env-diagnostics';
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

    // KIS baseUrl 판단 (vts = 모의투자 서버)
    const kisBaseUrl = process.env.KIS_BASE_URL || '';
    const kisBaseUrlType = kisBaseUrl.includes('openapivts') ? 'vts' : kisBaseUrl ? 'real' : 'not_set';

    return NextResponse.json({
      success: true,
      runtime: git.gitCommitSha && !process.env.RAILWAY_SERVICE_ID ? 'local' : process.env.RAILWAY_SERVICE_ID ? 'railway' : 'unknown',
      database: { connected: dbConnected },
      kis: {
        configured: env.kisConfigured,
        baseUrl: kisBaseUrlType,
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
