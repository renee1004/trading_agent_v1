// 환경변수 로딩 상태 진단 (민감값 없이 boolean만 반환)
// /api/agent/status, /api/system/local-health 에서 공통 사용

/**
 * KIS 필수 환경변수 존재 여부 (boolean만, 원문 절대 노출 금지)
 * kis-config-loader.ts의 fallback 체인과 동일하게 확인
 */
export function getEnvDiagnostics() {
  const appKeyLoaded = !!(
    process.env.KIS_APP_KEY ||
    process.env.KIS_APPKEY ||
    process.env.APP_KEY
  );
  const appSecretLoaded = !!(
    process.env.KIS_APP_SECRET ||
    process.env.KIS_APPSECRET ||
    process.env.APP_SECRET
  );
  const accountNoLoaded = !!(
    process.env.KIS_ACCOUNT_NO ||
    process.env.KIS_ACCOUNT ||
    process.env.ACCOUNT_NO
  );
  const accountProductCodeLoaded = !!process.env.KIS_ACCOUNT_PRODUCT_CODE;

  const baseUrl = process.env.KIS_BASE_URL || '';
  const baseUrlLoaded = !!baseUrl;
  // baseUrl이 'vts' 포함이면 모의투자 서버로 간주
  const isVirtualServer = baseUrl.includes('openapivts');

  return {
    databaseUrlLoaded: !!process.env.DATABASE_URL,
    kisAppKeyLoaded: appKeyLoaded,
    kisAppSecretLoaded: appSecretLoaded,
    kisAccountNoLoaded: accountNoLoaded,
    kisAccountProductCodeLoaded: accountProductCodeLoaded,
    kisBaseUrlLoaded: baseUrlLoaded,
    tradingModeEnv: process.env.TRADING_MODE || null,
    orderExecutionModeEnv: process.env.ORDER_EXECUTION_MODE || null,
    allowRealDomesticOrderEnv: process.env.ALLOW_REAL_DOMESTIC_ORDER === 'true',
    allowRealOverseasOrderEnv: process.env.ALLOW_REAL_OVERSEAS_ORDER === 'true',
    allowStrategyTestOrderEnv: process.env.ALLOW_STRATEGY_TEST_ORDER === 'true',
    killSwitchEnv: process.env.KILL_SWITCH_ENABLED === 'true',
    kisConfigured: appKeyLoaded && appSecretLoaded && accountNoLoaded,
    kisVirtualServer: isVirtualServer,
  };
}

/**
 * 로컬 개발 모드에서 git 정보 읽기
 * Railway 환경변수가 없으면 git 명령어로 fallback
 * 실패 시 null 반환 (앱 실행을 막지 않음)
 */
export async function getGitVersionInfo(): Promise<{
  gitCommitSha: string | null;
  gitBranch: string | null;
}> {
  // Railway 환경변수 우선
  if (process.env.RAILWAY_GIT_COMMIT_SHA) {
    return {
      gitCommitSha: process.env.RAILWAY_GIT_COMMIT_SHA,
      gitBranch: process.env.RAILWAY_GIT_BRANCH || null,
    };
  }

  // 로컬: git 명령어로 fallback
  try {
    const { execSync } = await import('child_process');
    const sha = execSync('git rev-parse HEAD', { timeout: 3000, encoding: 'utf-8' }).trim();
    let branch: string | null = null;
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { timeout: 3000, encoding: 'utf-8' }).trim();
    } catch { /* branch 조회 실패 무시 */ }
    return { gitCommitSha: sha, gitBranch: branch };
  } catch {
    return { gitCommitSha: null, gitBranch: null };
  }
}