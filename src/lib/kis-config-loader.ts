// KIS 설정 로더 공통 모듈
// 환경변수 fallback 우선순위, 계좌번호 정규화, DB 자동 저장을 통합 관리
// trading-agent.ts, /api/kis/config, /api/kis/token, /api/kis/balance에서 공동 사용

import { db } from './db';
import { KisConfig } from './types';

/**
 * KIS 계좌번호 정규화
 * - 하이픈 제거
 * - 8자리 → '01' 자동 추가 (상품코드 기본값)
 * - 10자리 → 그대로 사용
 * - 그 외 → 에러 throw
 */
export function normalizeKisAccountNo(raw: string): string {
  const normalized = raw.replace(/-/g, '').trim();

  if (/^\d{8}$/.test(normalized)) {
    return `${normalized}01`;
  }

  if (/^\d{10}$/.test(normalized)) {
    return normalized;
  }

  throw new Error(
    `KIS 계좌번호 형식이 올바르지 않습니다: ${raw}. 예: 50123456, 50123456-01, 5012345601`
  );
}

/**
 * 환경변수에서 KIS 설정 읽기 (fallback 우선순위 적용)
 *
 * appKey:
 *   1) KIS_APP_KEY
 *   2) KIS_APPKEY
 *   3) APP_KEY
 *
 * appSecret:
 *   1) KIS_APP_SECRET
 *   2) KIS_APPSECRET
 *   3) APP_SECRET
 *
 * accountNo (정규화 후 10자리):
 *   1) KIS_ACCOUNT_NO
 *   2) KIS_ACCOUNT
 *   3) ACCOUNT_NO
 *
 * isDemo:
 *   1) KIS_IS_DEMO
 *   2) KIS_VIRTUAL
 *   3) KIS_BASE_URL에 openapivts 포함 여부
 *   4) 기본값 true
 */
export function readKisConfigFromEnv(): {
  appKey: string;
  appSecret: string;
  accountNo: string; // 정규화된 10자리
  isDemo: boolean;
} | null {
  // appKey fallback
  const appKey =
    process.env.KIS_APP_KEY ||
    process.env.KIS_APPKEY ||
    process.env.APP_KEY ||
    '';

  // appSecret fallback
  const appSecret =
    process.env.KIS_APP_SECRET ||
    process.env.KIS_APPSECRET ||
    process.env.APP_SECRET ||
    '';

  // accountNo fallback (8자리 → 10자리 정규화)
  const rawAccountNo =
    process.env.KIS_ACCOUNT_NO ||
    process.env.KIS_ACCOUNT ||
    process.env.ACCOUNT_NO ||
    '';

  if (!appKey || !appSecret || !rawAccountNo) {
    return null;
  }

  // 계좌번호 정규화
  let accountNo: string;
  try {
    accountNo = normalizeKisAccountNo(rawAccountNo);
  } catch (e) {
    console.error(
      `[KIS Config Loader] ${e instanceof Error ? e.message : e}`
    );
    return null;
  }

  // isDemo fallback
  let isDemo = true; // 기본값: 모의투자
  if (process.env.KIS_IS_DEMO !== undefined) {
    isDemo = process.env.KIS_IS_DEMO !== 'false';
  } else if (process.env.KIS_VIRTUAL !== undefined) {
    isDemo = process.env.KIS_VIRTUAL !== 'false';
  } else if (
    process.env.KIS_BASE_URL &&
    process.env.KIS_BASE_URL.includes('openapivts')
  ) {
    isDemo = true;
  }

  return { appKey, appSecret, accountNo, isDemo };
}

/**
 * DB + 환경변수에서 KIS 설정 로드 (공통 함수)
 *
 * 1순위: DB에 저장된 설정
 * 2순위: 환경변수 (fallback 우선순위 적용)
 * 환경변수에서 로드 시 DB에 자동 저장
 * DB 저장 실패해도 설정은 반환
 *
 * @returns KisConfig | null
 */
export async function getOrCreateKisConfigFromEnv(): Promise<KisConfig | null> {
  // 1. DB에서 설정 조회
  try {
    const dbConfig = await db.kisConfig.findFirst();
    if (dbConfig) {
      console.log('[KIS Config Loader] DB에서 KIS 설정 로드 성공');
      return {
        appKey: dbConfig.appKey,
        appSecret: dbConfig.appSecret,
        accountNo: dbConfig.accountNo,
        isDemo: dbConfig.isDemo,
        accessToken: dbConfig.accessToken || undefined,
        tokenExpiresAt: dbConfig.tokenExpiresAt ?? undefined,
      };
    }
  } catch (dbError) {
    console.warn(
      '[KIS Config Loader] DB 조회 실패, 환경변수로 대체:',
      dbError instanceof Error ? dbError.message : String(dbError)
    );
  }

  // 2. 환경변수에서 설정 로드
  const envConfig = readKisConfigFromEnv();
  if (!envConfig) {
    console.log(
      '[KIS Config Loader] KIS 설정 없음: KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NO 또는 KIS_ACCOUNT 환경변수를 확인하세요.'
    );
    return null;
  }

  // App Key 마스킹 로그 (앞 4자리만)
  const maskedKey = envConfig.appKey.substring(0, 4) + '****';
  console.log(
    `[KIS Config Loader] 환경변수에서 KIS 설정 로드 성공 (appKey=${maskedKey}, accountNo=${envConfig.accountNo}, isDemo=${envConfig.isDemo})`
  );

  // 3. DB에 자동 저장 (다음 조회부터 DB에서 바로 로드)
  try {
    await db.kisConfig.create({
      data: {
        appKey: envConfig.appKey,
        appSecret: envConfig.appSecret,
        accountNo: envConfig.accountNo,
        isDemo: envConfig.isDemo,
      },
    });
    console.log('[KIS Config Loader] KIS 설정 DB 자동 저장 완료');
  } catch (dbError) {
    console.error(
      '[KIS Config Loader] KIS 설정 DB 자동 저장 실패:',
      dbError instanceof Error ? dbError.message : String(dbError)
    );
    // DB 저장 실패해도 env 설정으로 KisConfig는 반환
  }

  return {
    appKey: envConfig.appKey,
    appSecret: envConfig.appSecret,
    accountNo: envConfig.accountNo,
    isDemo: envConfig.isDemo,
  };
}
