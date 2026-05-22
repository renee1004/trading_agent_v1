import { NextRequest, NextResponse } from 'next/server';

/**
 * 관리자용 API 보호 가드
 *
 * Railway/배포 환경변수에 ADMIN_API_TOKEN을 설정한 뒤,
 * 요청 헤더에 x-admin-token: <ADMIN_API_TOKEN> 값을 넣어 호출해야 합니다.
 *
 * ADMIN_API_TOKEN이 설정되지 않은 환경에서는 배포 후 외부 API 호출을 막기 위해 500을 반환합니다.
 */
export function requireAdminApiToken(request: NextRequest): NextResponse | null {
  const expectedToken = process.env.ADMIN_API_TOKEN;

  if (!expectedToken) {
    return NextResponse.json(
      {
        success: false,
        error: 'ADMIN_API_TOKEN 환경변수가 설정되지 않았습니다.',
      },
      { status: 500 }
    );
  }

  const providedToken = request.headers.get('x-admin-token');

  if (!providedToken || providedToken !== expectedToken) {
    return NextResponse.json(
      {
        success: false,
        error: '권한이 없습니다.',
      },
      { status: 401 }
    );
  }

  return null;
}
