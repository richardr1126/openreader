import type { NextRequest } from 'next/server';
import { getAuthContext, getTrustedOrigins } from '@/lib/server/auth/auth';
import { apiErrorResponse } from '@/lib/server/api/responses';

export const API_SCOPES = ['documents:read', 'documents:write', 'audio:generate'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Who a `/api/v1` request acts for, whichever credential it arrived with. */
export type ApiPrincipal = {
  userId: string;
  isAnonymous: boolean;
  scopes: readonly ApiScope[];
};

function isCrossSiteWrite(request: NextRequest): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'none';
  // Plain-HTTP LAN deployments do not get Sec-Fetch-* headers from browsers.
  const origin = request.headers.get('origin');
  if (!origin) return false;
  return origin !== request.nextUrl.origin && !getTrustedOrigins().includes(origin);
}

/**
 * Resolves a v1 request to its principal. A session cookie carries the web
 * app's full access, so a write with one must come from the app's own origin.
 */
export async function resolveApiPrincipal(
  request: NextRequest,
  requiredScope: ApiScope,
): Promise<ApiPrincipal | Response> {
  const context = await getAuthContext(request);
  if (!context.userId) return apiErrorResponse(401, 'UNAUTHORIZED', 'Sign in to use this API.');
  if (isCrossSiteWrite(request)) {
    return apiErrorResponse(403, 'CROSS_SITE_REQUEST', 'Cross-site requests are not allowed.');
  }
  const principal: ApiPrincipal = {
    userId: context.userId,
    isAnonymous: Boolean(context.user?.isAnonymous),
    scopes: API_SCOPES,
  };
  if (!principal.scopes.includes(requiredScope)) {
    return apiErrorResponse(403, 'INSUFFICIENT_SCOPE', `This request needs the ${requiredScope} scope.`);
  }
  return principal;
}
