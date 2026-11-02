/**
 * What a person should check before approving. A custom scheme is the app that
 * registered it, whatever host follows, so `evil://claude.ai` must not read as claude.ai.
 */
export function oauthRedirectDestination(uri: string): string {
  const target = new URL(uri);
  if (target.protocol === 'http:' || target.protocol === 'https:') return target.host;
  return `${target.protocol}//${target.host}`;
}

/** Direct SQL reads bypass Better Auth's SQLite JSON decoding. */
export function oauthStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
}
