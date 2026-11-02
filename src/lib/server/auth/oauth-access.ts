import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import * as sqlite from '@openreader/database/schema-auth-sqlite';
import * as postgres from '@openreader/database/schema-auth-postgres';
import { getAuth } from './auth';
import { API_SCOPES } from '@/lib/shared/api-scopes';
import type { ApiPrincipal } from '@/lib/server/api/principal';
import { oauthStringArray } from './oauth-values';

const schema = process.env.POSTGRES_URL ? postgres : sqlite;

/** Verify locally with the auth-owned JWKS, then check current authorization. */
export async function resolveOAuthAccess(token: string, resource: string): Promise<ApiPrincipal | null> {
  if (token.length > 16384) return null;
  try {
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    if (header.typ !== 'at+jwt') return null;
  } catch { return null; }
  const auth = await getAuth();
  const { payload } = await auth.api.verifyJWT({ body: { token } });
  if (!payload || payload.aud !== resource || typeof payload.sub !== 'string' || typeof payload.client_id !== 'string'
    || payload.azp !== payload.client_id || typeof payload.or_grant !== 'string' || typeof payload.scope !== 'string'
    || typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now() || payload.cnf) return null;
  const rows = await db.select({ user: schema.user, consent: schema.oauthConsent, client: schema.oauthClient })
    .from(schema.oauthConsent).innerJoin(schema.user, eq(schema.user.id, schema.oauthConsent.userId))
    .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId)).where(and(
      eq(schema.oauthConsent.id, payload.or_grant), eq(schema.oauthConsent.userId, payload.sub), eq(schema.oauthConsent.clientId, payload.client_id),
    )).limit(1);
  const row = rows[0];
  if (!row || row.user.isAnonymous || row.user.accessStatus !== 'active' || row.user.deletionRequestedAt || row.client.disabled
    || (auth.options.emailAndPassword?.requireEmailVerification && !row.user.emailVerified)) return null;
  const scopes = payload.scope.split(' ');
  const approved = oauthStringArray(row.consent.scopes);
  if (!scopes.every(scope => approved.includes(scope))) return null;
  // A delegated grant outlives the browser session that approved it. Its live
  // consent ID, account and client checks above own immediate revocation.
  return { userId: payload.sub, isAnonymous: false, clientId: payload.client_id, scopes: API_SCOPES.filter(scope => scopes.includes(scope)) };
}
