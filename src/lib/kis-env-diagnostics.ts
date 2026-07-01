// KIS 설정 상태 판정 공통 모듈
// local-health, agent/status, trading-agent, kis-api 등 모든 경로에서 동일 기준 사용
// ─────────────────────────────────────────────────────────
// 절대 금지: KIS_APP_KEY, KIS_APP_SECRET, 계좌번호 원문 노출
// 절대 금지: 키 값 일부 마스킹도 금지 — 변수명(missingKeys)만 표시

/**
 * KIS 필수 환경변수명 목록 (우선순위 그룹별)
 * kis-config-loader.ts의 fallback 체인과 정확히 일치
 */
const REQUIRED_ENV_GROUPS: Record<string, string[]> = {
  appKey: ['KIS_APP_KEY', 'KIS_APPKEY', 'APP_KEY'],
  appSecret: ['KIS_APP_SECRET', 'KIS_APPSECRET', 'APP_SECRET'],
  accountNo: ['KIS_ACCOUNT_NO', 'KIS_ACCOUNT', 'ACCOUNT_NO'],
};

export interface KisEnvDiagnostics {
  kisConfigured: boolean;
  missingKeys: string[];
  baseUrlType: 'vts' | 'real' | 'unknown';
  hasAppKey: boolean;
  hasAppSecret: boolean;
  hasAccountNo: boolean;
  hasAccountProductCode: boolean;
  allowRealFallback: boolean;
  /** TRADING_MODE이 'REAL'이 아니면 true (DEMO, 미설정 포함) */
  isDemo: boolean;
}

/**
 * KIS 설정 완전성 판정 (공통 함수)
 *
 * 판정 기준:
 *   kisConfigured = hasAppKey && hasAppSecret && hasAccountNo
 *   (KIS_ACCOUNT_PRODUCT_CODE는 진단에 포함하되 configured 판정에는 불포함 —
 *    기존 kis-config-loader.ts가 PRODUCT_CODE 없이도 로드하므로)
 *
 * env-diagnostics.ts의 getEnvDiagnostics()와 local-health/agent/status의
 * kisConfigured가 항상 같은 값을 반환하도록 이 함수를 단일 진실 공급원으로 사용.
 */
export function getKisEnvDiagnostics(): KisEnvDiagnostics {
  // 1. 각 필수 키 존재 여부 (fallback 우선순위 그룹)
  const hasAppKey = REQUIRED_ENV_GROUPS.appKey.some(k => !!process.env[k]);
  const hasAppSecret = REQUIRED_ENV_GROUPS.appSecret.some(k => !!process.env[k]);
  const hasAccountNo = REQUIRED_ENV_GROUPS.accountNo.some(k => !!process.env[k]);
  const hasAccountProductCode = !!process.env.KIS_ACCOUNT_PRODUCT_CODE;

  // 2. 누락 키 수집 (변수명만, 원문 절대 노출 금지)
  const missingKeys: string[] = [];
  if (!hasAppKey) missingKeys.push('KIS_APP_KEY');
  if (!hasAppSecret) missingKeys.push('KIS_APP_SECRET');
  if (!hasAccountNo) missingKeys.push('KIS_ACCOUNT_NO');
  if (!hasAccountProductCode) missingKeys.push('KIS_ACCOUNT_PRODUCT_CODE');

  // 3. baseUrl 판단
  const baseUrl = process.env.KIS_BASE_URL || '';
  let baseUrlType: 'vts' | 'real' | 'unknown' = 'unknown';
  if (baseUrl.includes('openapivts')) {
    baseUrlType = 'vts';
  } else if (baseUrl.includes('openapi.koreainvestment')) {
    baseUrlType = 'real';
  }

  // 4. 실전 서버 fallback 허용 여부 (기본값: false)
  //    TRADING_MODE=DEMO이면 무조건 false — 모의투자에서 실전 서버 호출 금지
  //    ALLOW_REAL_DOMESTIC_ORDER=false이면 무조건 false — 실전 주문 불가하면 조회도 fallback 금지
  const isDemo = process.env.TRADING_MODE !== 'REAL';
  const allowRealDomesticOrder = process.env.ALLOW_REAL_DOMESTIC_ORDER === 'true';
  const envAllow = process.env.KIS_ALLOW_REAL_FALLBACK === 'true';
  const allowRealFallback = envAllow && !isDemo && allowRealDomesticOrder;

  // 5. 최종 판정
  const kisConfigured = hasAppKey && hasAppSecret && hasAccountNo;

  return {
    kisConfigured,
    missingKeys,
    baseUrlType,
    hasAppKey,
    hasAppSecret,
    hasAccountNo,
    hasAccountProductCode,
    allowRealFallback,
    isDemo,
  };
}

/**
 * KIS 미설정 시 로그 메시지 생성 (공통)
 * missingKeys는 변수명 콤마 구분 문자열
 */
export function getKisNotConfiguredMessage(diag?: KisEnvDiagnostics): string {
  const d = diag || getKisEnvDiagnostics();
  return `KIS 설정 불완전으로 국내 분석을 건너뜀. missingKeys=${d.missingKeys.join(',')}`;
}
