import { NextRequest, NextResponse } from 'next/server';

/**
 * Optional admin API guard.
 *
 * Set ADMIN_API_TOKEN in the deployment environment to enable protection.
 * When ADMIN_API_TOKEN is not set, the guard allows requests so local/demo
 * deployments keep working without changing the frontend.
 */
export function requireAdminApiToken(request: NextRequest): NextResponse | null {
  const expectedToken = process.env.ADMIN_API_TOKEN;

  if (!expectedToken) {
    return null;
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
