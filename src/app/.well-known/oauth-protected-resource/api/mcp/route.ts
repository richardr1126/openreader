import { NextResponse } from 'next/server';
import { getRequiredAuthEnv } from '@/lib/server/auth/config';
import { oauthUrls } from '@/lib/server/auth/oauth';
import { OAUTH_SCOPES } from '@/lib/shared/api-scopes';
export function GET() {
  const urls = oauthUrls(getRequiredAuthEnv().baseUrl);
  // Connectors request these as listed, and need offline_access to stay signed in past the 15-minute token.
  return NextResponse.json({ resource: urls.mcpResource, authorization_servers: [urls.issuer], scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ['header'], resource_name: 'OpenReader MCP' });
}
