import { NextResponse } from 'next/server';
import { getRequiredAuthEnv } from '@/lib/server/auth/config';
import { oauthUrls } from '@/lib/server/auth/oauth';
import { API_SCOPES } from '@/lib/shared/api-scopes';
export function GET() {
  const urls = oauthUrls(getRequiredAuthEnv().baseUrl);
  return NextResponse.json({ resource: urls.resource, authorization_servers: [urls.issuer], scopes_supported: API_SCOPES,
    bearer_methods_supported: ['header'], resource_name: 'OpenReader public API' });
}
