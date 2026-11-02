import { createMcpHandler, originValidationResponse } from '@modelcontextprotocol/server';
import { NextRequest } from 'next/server';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { getTrustedOrigins } from '@/lib/server/auth/auth';
import { getRequiredAuthEnv } from '@/lib/server/auth/config';
import { oauthUrls } from '@/lib/server/auth/oauth';
import { resolveOAuthAccess } from '@/lib/server/auth/oauth-access';
import { createRequestLogger } from '@/lib/server/logger';
import { createMcpServer, mcpAuthInfo } from '@/lib/server/mcp/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = createMcpHandler(createMcpServer);

/** Bearer tokens only: a session cookie never reaches this route's tools, and browsers get no CORS. */
async function handle(request: NextRequest): Promise<Response> {
  const { logger } = createRequestLogger({ route: '/api/mcp', request });
  try {
    const rejected = originValidationResponse(request, getTrustedOrigins().map(origin => new URL(origin).hostname));
    if (rejected) return rejected;
    const urls = oauthUrls(getRequiredAuthEnv().baseUrl);
    const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    const principal = token ? await resolveOAuthAccess(token, urls.mcpResource) : null;
    if (!token || !principal) {
      const response = apiErrorResponse(401, 'INVALID_TOKEN', 'A valid OAuth access token is required.');
      response.headers.set('WWW-Authenticate', `Bearer resource_metadata="${urls.mcpMetadata}"${token ? ', error="invalid_token"' : ''}`);
      return response;
    }
    return await handler.fetch(request, { authInfo: mcpAuthInfo(token, principal, urls.mcpResource, urls.mcpMetadata) });
  } catch (error) {
    return apiCatchResponse(error, { logger, event: 'mcp.request_failed', msg: 'MCP request failed.', normalize: { code: 'MCP_REQUEST_FAILED', errorClass: 'unknown' } });
  }
}

export { handle as GET, handle as POST, handle as DELETE };
