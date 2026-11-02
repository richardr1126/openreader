import { jwt } from 'better-auth/plugins';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { extendOAuthProvider, getOAuthProviderApi, oauthDeviceAuthorization, oauthProvider, DEVICE_CODE_GRANT_TYPE, type OAuthOptions } from '@better-auth/oauth-provider';
import { OAUTH_SCOPES } from '@/lib/shared/api-scopes';

export function oauthUrls(baseUrl: string) {
  const origin = baseUrl.replace(/\/$/, '');
  return { issuer: `${origin}/api/auth`, resource: `${origin}/api/v1`, metadata: `${origin}/.well-known/oauth-protected-resource/api/v1` };
}

function assertOAuthUser(user: Record<string, unknown> | null | undefined, requireVerifiedEmail: boolean) {
  if (!user || user.isAnonymous || (user.accessStatus && user.accessStatus !== 'active') || user.deletionRequestedAt
    || (requireVerifiedEmail && !user.emailVerified)) {
    throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: 'Sign in to an active, non-guest account to connect an app.' });
  }
}

/** Registration is open to anyone, and these values are stored and shown on the consent page. */
function assertRegistrationLimits(body: Record<string, unknown> | undefined) {
  const invalid = (field: string) => new APIError('BAD_REQUEST', { error: 'invalid_client_metadata', error_description: `${field} is too long.` });
  for (const [field, limit] of Object.entries({ client_name: 200, client_uri: 2048, logo_uri: 2048, tos_uri: 2048, policy_uri: 2048, software_id: 256, software_version: 256, software_statement: 16384 })) {
    const value = body?.[field];
    if (typeof value === 'string' && value.length > limit) throw invalid(field);
  }
  for (const [field, count, limit] of [['redirect_uris', 20, 2048], ['post_logout_redirect_uris', 20, 2048], ['contacts', 10, 320]] as const) {
    const value = body?.[field];
    if (Array.isArray(value) && (value.length > count || value.some(item => typeof item === 'string' && item.length > limit))) throw invalid(field);
  }
}

/** Grant identity makes deleting consent invalidate JWTs even after a later reconnect. */
function oauthGrantPolicy(requireVerifiedEmail: boolean, resource: string): BetterAuthPlugin {
  const grants = new WeakMap<Request, { id: string; options: OAuthOptions<string[]> }>();
  const deviceGrants = new WeakMap<Request, string>();
  return {
    id: 'openreader-oauth-grants',
    init(context) {
      extendOAuthProvider(context, { claims: { accessToken: async ({ ctx, opts, user, client, scopes, grantType, referenceId }) => {
        assertOAuthUser(user, requireVerifiedEmail);
        const where = [{ field: 'userId', value: user!.id }, { field: 'clientId', value: client.clientId }];
        const consent = await ctx.context.adapter.findOne<{ id: string; scopes: string[] }>({ model: 'oauthConsent', where });
        if (!consent || !scopes.every(scope => consent.scopes.includes(scope))
          || (grantType === DEVICE_CODE_GRANT_TYPE && (!ctx.request || deviceGrants.get(ctx.request) !== consent.id))
          || (grantType === 'refresh_token' && referenceId !== consent.id)) {
          throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: 'This app needs new consent.' });
        }
        if (ctx.request) grants.set(ctx.request, { id: consent.id, options: opts });
        return { or_grant: consent.id };
      } } });
    },
    hooks: { before: [{
      matcher: context => context.path === '/oauth2/register',
      handler: createAuthMiddleware(async context => { assertRegistrationLimits(context.body); }),
    }, {
      matcher: context => ['/oauth2/authorize', '/device/code', '/oauth2/consent', '/device', '/device/approve', '/device/deny'].includes(context.path ?? '')
        || (context.path === '/oauth2/token' && context.body?.grant_type === DEVICE_CODE_GRANT_TYPE),
      handler: createAuthMiddleware(async context => {
        if (context.path === '/oauth2/token') {
          // Capture the grant before the provider atomically consumes the code.
          // Issuance must not recreate consent after a concurrent disconnect.
          const rawCode = context.body?.device_code;
          if (typeof rawCode !== 'string' || !rawCode) return;
          const code = await context.context.adapter.findOne<{ userId?: string; oauthClientId?: string; status: string }>({
            model: 'deviceCode', where: [{ field: 'deviceCode', value: rawCode }],
          });
          if (code?.status === 'approved' && code.userId && code.oauthClientId && context.request) {
            const consent = await context.context.adapter.findOne<{ id: string }>({ model: 'oauthConsent', where: [
              { field: 'userId', value: code.userId }, { field: 'clientId', value: code.oauthClientId },
            ] });
            if (consent) deviceGrants.set(context.request, consent.id);
          }
          return;
        }
        if (context.path === '/oauth2/authorize' || context.path === '/device/code') {
          const requested = context.path === '/oauth2/authorize' ? context.query?.resource : context.body?.resource;
          if (requested !== resource && !(Array.isArray(requested) && requested.length === 1 && requested[0] === resource)) {
            throw new APIError('BAD_REQUEST', { error: 'invalid_target', error_description: 'Request the public API resource explicitly.' });
          }
          if (context.path === '/device/code') {
            let clientId = context.body?.client_id;
            const authorization = context.headers?.get('authorization');
            if (!clientId && authorization?.startsWith('Basic ')) {
              try { clientId = decodeURIComponent(Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':')[0]); } catch { /* Invalid client authentication is rejected below. */ }
            }
            // The companion plugin otherwise falls back to first-party device
            // sessions for unknown IDs. OpenReader exposes only OAuth devices.
            const client = typeof clientId === 'string' ? await context.context.adapter.findOne({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] }) : null;
            if (!client) throw new APIError('BAD_REQUEST', { error: 'invalid_client', error_description: 'A registered OAuth client is required.' });
          }
          return;
        }
        const session = await getSessionFromCtx(context);
        assertOAuthUser(session?.user, requireVerifiedEmail);
        if (context.path === '/device/approve') {
          const userCode = typeof context.body?.userCode === 'string' ? context.body.userCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '';
          const code = await context.context.adapter.findOne<{ userId?: string; oauthClientId?: string; status: string; expiresAt: Date; scope?: string }>({
            model: 'deviceCode', where: [{ field: 'userCode', value: userCode }],
          });
          if (!code || code.status !== 'pending' || code.userId !== session!.user.id || code.expiresAt <= new Date() || !code.oauthClientId) {
            throw new APIError('BAD_REQUEST', { error: 'invalid_request', error_description: 'This device code cannot be approved.' });
          }
          // Persist explicit consent before making the code redeemable. The
          // provider still owns approval validation and single-use redemption.
          const where = [{ field: 'userId', value: session!.user.id }, { field: 'clientId', value: code.oauthClientId }];
          const consent = await context.context.adapter.findOne<{ id: string; scopes: string[] }>({ model: 'oauthConsent', where });
          const scopes = code.scope?.split(' ').filter(Boolean) ?? [];
          const now = new Date();
          if (consent) await context.context.adapter.update({ model: 'oauthConsent', where: [{ field: 'id', value: consent.id }],
            update: { scopes: [...new Set([...consent.scopes, ...scopes])], updatedAt: now } });
          else await context.context.adapter.create({ model: 'oauthConsent', data: {
            userId: session!.user.id, clientId: code.oauthClientId, scopes, resources: [resource], createdAt: now, updatedAt: now,
          } });
        }
      }),
    }], after: [{
      matcher: context => context.path === '/oauth2/token',
      handler: createAuthMiddleware(async context => {
        const returned = context.context.returned;
        const result = returned instanceof Response ? await returned.clone().json().catch(() => null) : returned;
        if (!result || typeof result.refresh_token !== 'string') return;
        const grant = context.request ? grants.get(context.request) : undefined;
        if (!grant) throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: 'Missing authorization grant.' });
        const hash = await getOAuthProviderApi(context, grant.options).hashToken(result.refresh_token, 'refresh_token');
        const consent = await context.context.adapter.findOne({ model: 'oauthConsent', where: [{ field: 'id', value: grant.id }] });
        if (!consent) {
          await context.context.adapter.delete({ model: 'oauthRefreshToken', where: [{ field: 'token', value: hash }] });
          throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: 'Authorization was disconnected.' });
        }
        const bound = await context.context.adapter.update({ model: 'oauthRefreshToken', where: [{ field: 'token', value: hash }], update: { referenceId: grant.id } });
        if (!bound) throw new APIError('FORBIDDEN', { error: 'access_denied', error_description: 'Authorization was disconnected.' });
        if (context.request) grants.delete(context.request);
      }),
    }] },
  };
}

export function oauthPlugins(baseUrl: string, allowRegistration: boolean, requireVerifiedEmail: boolean) {
  const urls = oauthUrls(baseUrl);
  return [
    jwt({ disableSettingJwtHeader: true, jwt: { issuer: urls.issuer, audience: urls.resource, expirationTime: '15m' } }),
    oauthProvider({ loginPage: '/signin', consentPage: '/oauth/consent',
      scopes: [...OAUTH_SCOPES], grantTypes: ['authorization_code', 'refresh_token'],
      allowDynamicClientRegistration: allowRegistration,
      allowUnauthenticatedClientRegistration: allowRegistration,
      clientRegistrationRequirePKCE: true, clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
      resources: [{ identifier: urls.resource, allowedScopes: [...OAUTH_SCOPES], accessTokenTtl: 900 }],
      clientRegistrationDefaultResources: [urls.resource],
      resourcePrivileges: () => false,
      accessTokenExpiresIn: 900, refreshTokenExpiresIn: 30 * 24 * 60 * 60, refreshTokenReuseInterval: 0,
      clientPrivileges: ({ user, action }) => action !== 'configure-client-credentials-scopes' && !!user && !user.isAnonymous && (!user.accessStatus || user.accessStatus === 'active'),
      postLogin: { page: '/oauth/sign-in', consentReferenceId: () => undefined,
        shouldRedirect: ({ user }) => Boolean(user.isAnonymous || (user.accessStatus && user.accessStatus !== 'active')) },
    }),
    oauthDeviceAuthorization({ verificationUri: '/oauth/device' }),
    oauthGrantPolicy(requireVerifiedEmail, urls.resource),
  ];
}
