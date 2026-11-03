import { and, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import * as sqlite from '@openreader/database/schema-auth-sqlite';
import * as postgres from '@openreader/database/schema-auth-postgres';
import { apiRequest } from '@/lib/server/api/request';
import { ApiRequestError } from '@/lib/server/api/responses';
import { hasBearerAuthorization, type ApiPrincipal } from '@/lib/server/api/principal';
import { getAuth } from './auth';
import { getRequiredAuthEnv } from './config';
import { oauthUrls } from './oauth';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { OAUTH_SCOPES } from '@/lib/shared/api-scopes';
import { fetchOAuthClientLogo } from './oauth-client-logo';
import { oauthClientLogoUrl, oauthRedirectDestination, oauthStringArray, oauthVerifiedDomain } from './oauth-values';

const schema = process.env.POSTGRES_URL ? postgres : sqlite;
export function oauthCookieRequest(request: NextRequest, run: (principal: ApiPrincipal) => Promise<Response>) {
  if (hasBearerAuthorization(request)) return Promise.resolve(NextResponse.json({ error: { code: 'COOKIE_REQUIRED', message: 'Use your signed-in browser to manage connected apps.' } }, { status: 403 }));
  return apiRequest(request, request.method === 'GET' ? 'documents:read' : 'documents:write', async principal => {
    const rows = await db.select().from(schema.user).where(eq(schema.user.id, principal.userId)).limit(1);
    if (principal.isAnonymous || !rows[0] || rows[0].accessStatus !== 'active' || rows[0].deletionRequestedAt) {
      throw new ApiRequestError(403, 'ACCOUNT_REQUIRED', 'Sign in to an active account to connect an app.');
    }
    return run(principal);
  });
}

export async function listConnectedApps(userId: string) {
  const rows = await db.select({ clientId: schema.oauthClient.clientId, name: schema.oauthClient.name, clientDiscoveryId: schema.oauthClient.clientDiscoveryId, icon: schema.oauthClient.icon,
    redirectUris: schema.oauthClient.redirectUris, consentId: schema.oauthConsent.id, scopes: schema.oauthConsent.scopes,
    createdAt: schema.oauthConsent.createdAt }).from(schema.oauthConsent)
    .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
    .where(eq(schema.oauthConsent.userId, userId));
  const grouped = new Map<string, { id: string; name: string; verifiedDomain: string | null; logoUrl: string | null; redirectDomains: string[]; scopes: string[]; createdAt: number }>();
  for (const row of rows) {
    const scopes = oauthStringArray(row.scopes);
    const existing = grouped.get(row.clientId);
    if (existing) { existing.scopes = [...new Set([...existing.scopes, ...scopes])]; continue; }
    grouped.set(row.clientId, { id: row.clientId, name: row.name || 'Unnamed app', verifiedDomain: oauthVerifiedDomain(row.clientId), logoUrl: oauthClientLogoUrl(row), scopes, createdAt: row.createdAt.getTime(),
      redirectDomains: [...new Set(oauthStringArray(row.redirectUris).flatMap(uri => {
        try { return [oauthRedirectDestination(uri)]; } catch { return []; }
      }))] });
  }
  return { data: [...grouped.values()], nextCursor: null };
}

export async function disconnectApp(userId: string, clientId: string) {
  if (!clientId || clientId.length > 512) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Invalid client ID.');
  await runInDbTransaction(async tx => {
    const where = and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId));
    await tx.delete(schema.oauthConsent).where(where);
    await tx.delete(schema.oauthAccessToken).where(and(eq(schema.oauthAccessToken.userId, userId), eq(schema.oauthAccessToken.clientId, clientId)));
    await tx.delete(schema.oauthRefreshToken).where(and(eq(schema.oauthRefreshToken.userId, userId), eq(schema.oauthRefreshToken.clientId, clientId)));
    await tx.delete(schema.deviceCode).where(and(eq(schema.deviceCode.userId, userId), eq(schema.deviceCode.oauthClientId, clientId)));
  });
}

export async function oauthRequestInfo(request: NextRequest) {
  const auth = await getAuth();
  const urls = oauthUrls(getRequiredAuthEnv().baseUrl);
  let clientId: string;
  let scopes: string[];
  // A device flow has no redirect, so there is nothing for the person to check.
  let destination: string | null = null;
  const userCode = request.nextUrl.searchParams.get('user_code');
  if (userCode) {
    if (userCode.length > 64) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Invalid device code.');
    const verified = await auth.api.deviceVerify({ query: { user_code: userCode }, headers: request.headers });
    clientId = verified.client_id || '';
    scopes = verified.scope?.split(' ').filter(Boolean) ?? [];
    const resource = verified.resource;
    if (resource !== urls.resource && !(Array.isArray(resource) && resource.length === 1 && resource[0] === urls.resource)) {
      throw new ApiRequestError(400, 'REQUEST_INVALID', 'This code is not for the public API.');
    }
  } else {
    const query = request.nextUrl.searchParams.get('query') || '';
    if (query.length > 16384 || !await verifyOAuthQueryParams(query, getRequiredAuthEnv().authSecret)) {
      throw new ApiRequestError(400, 'OAUTH_REQUEST_INVALID', 'This connection request expired or is invalid. Start again from the app.');
    }
    const parameters = new URLSearchParams(query);
    clientId = parameters.get('client_id') || '';
    scopes = parameters.get('scope')?.split(' ').filter(Boolean) ?? [];
    const redirectUri = parameters.get('redirect_uri');
    if (!redirectUri) throw new ApiRequestError(400, 'OAUTH_REQUEST_INVALID', 'A redirect URI is required.');
    try { destination = oauthRedirectDestination(redirectUri); }
    catch { throw new ApiRequestError(400, 'OAUTH_REQUEST_INVALID', 'A valid redirect URI is required.'); }
  }
  if (!scopes.length || scopes.some(scope => !(OAUTH_SCOPES as readonly string[]).includes(scope))) throw new ApiRequestError(400, 'OAUTH_REQUEST_INVALID', 'Unsupported requested scopes.');
  const clients = await db.select({ name: schema.oauthClient.name, disabled: schema.oauthClient.disabled, clientDiscoveryId: schema.oauthClient.clientDiscoveryId, icon: schema.oauthClient.icon })
    .from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)).limit(1);
  if (!clients[0] || clients[0].disabled) throw new ApiRequestError(404, 'APP_NOT_FOUND', 'App not found.');
  return { clientId, name: clients[0].name || 'Unnamed app', scopes, destination, verifiedDomain: oauthVerifiedDomain(clientId), logoUrl: oauthClientLogoUrl({ clientId, ...clients[0] }) };
}

export async function oauthClientLogo(clientId: string) {
  if (!clientId || clientId.length > 512) return null;
  const clients = await db.select({ disabled: schema.oauthClient.disabled, clientDiscoveryId: schema.oauthClient.clientDiscoveryId, icon: schema.oauthClient.icon })
    .from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)).limit(1);
  if (!clients[0] || clients[0].disabled) return null;
  return fetchOAuthClientLogo({ clientId, ...clients[0] });
}
