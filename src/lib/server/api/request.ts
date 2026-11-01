import type { NextRequest } from 'next/server';
import { resolveApiPrincipal, type ApiPrincipal, type ApiScope } from './principal';
import { apiCatchResponse } from './responses';
import { createRequestLogger } from '@/lib/server/logger';

export async function apiRequest(request: NextRequest, scope: ApiScope, run: (principal: ApiPrincipal) => Promise<Response>): Promise<Response> {
  const { logger } = createRequestLogger({ route: request.nextUrl.pathname, request });
  try {
    const principal = await resolveApiPrincipal(request, scope);
    if (principal instanceof Response) return principal;
    const response = await run(principal);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return apiCatchResponse(error, { logger, event: 'api.request_failed', msg: 'API request failed.',
      normalize: { code: 'API_REQUEST_FAILED', errorClass: 'unknown' } });
  }
}
