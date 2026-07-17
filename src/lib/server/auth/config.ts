export type RequiredAuthEnv = {
  authSecret: string;
  baseUrl: string;
};

function getRequiredEnvValue(name: 'AUTH_SECRET' | 'BASE_URL'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'OpenReader v4 requires both AUTH_SECRET and BASE_URL at startup.',
    );
  }
  return value;
}

export function getRequiredAuthEnv(): RequiredAuthEnv {
  return {
    authSecret: getRequiredEnvValue('AUTH_SECRET'),
    baseUrl: getRequiredEnvValue('BASE_URL'),
  };
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return defaultValue;

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return defaultValue;
}

/**
 * Anonymous sessions are opt-in.
 * Defaults to false when unset or invalid.
 */
export function isAnonymousAuthSessionsEnabled(): boolean {
  getRequiredAuthEnv();
  return parseBooleanEnv('USE_ANONYMOUS_AUTH_SESSIONS', false);
}

/**
 * GitHub sign-in is available when both GITHUB_CLIENT_ID and
 * GITHUB_CLIENT_SECRET are set.
 */
export function isGithubAuthEnabled(): boolean {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export type OidcAuthConfig = {
  providerId: string;
  providerName: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  scopes: string[];
};

/**
 * Public subset of the OIDC config that is safe to send to the client
 * (never include the client secret here).
 */
export type OidcPublicAuthConfig = Pick<OidcAuthConfig, 'providerId' | 'providerName'>;

/**
 * Generic OIDC sign-in is available when OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
 * and OIDC_DISCOVERY_URL are all set. Optional overrides:
 * - OIDC_PROVIDER_ID: URL-safe id used in the OAuth callback path
 *   (`/api/auth/oauth2/callback/<id>`), defaults to "oidc"
 * - OIDC_PROVIDER_NAME: display name for the sign-in button, defaults to "SSO"
 * - OIDC_SCOPES: space- or comma-separated, defaults to "openid profile email"
 */
export function getOidcAuthConfig(): OidcAuthConfig | null {
  const clientId = process.env.OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim();
  const discoveryUrl = process.env.OIDC_DISCOVERY_URL?.trim();
  if (!clientId || !clientSecret || !discoveryUrl) return null;

  const providerId = process.env.OIDC_PROVIDER_ID?.trim() || 'oidc';
  if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) {
    throw new Error(
      'Invalid OIDC_PROVIDER_ID: it becomes part of the OAuth callback URL '
      + 'and may only contain letters, numbers, hyphens, and underscores.',
    );
  }

  const providerName = process.env.OIDC_PROVIDER_NAME?.trim() || 'SSO';
  const scopes = (process.env.OIDC_SCOPES?.trim() || 'openid profile email')
    .split(/[\s,]+/)
    .filter(Boolean);

  return { providerId, providerName, clientId, clientSecret, discoveryUrl, scopes };
}

export function getOidcPublicAuthConfig(): OidcPublicAuthConfig | null {
  const config = getOidcAuthConfig();
  if (!config) return null;
  return { providerId: config.providerId, providerName: config.providerName };
}

/**
 * Get the required auth base URL.
 */
export function getAuthBaseUrl(): string {
  return getRequiredAuthEnv().baseUrl;
}
