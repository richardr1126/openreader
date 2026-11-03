/**
 * What a person should check before approving. The scheme stays visible: a custom
 * scheme is the app that registered it, whatever host follows, so `evil://claude.ai`
 * must not read as claude.ai, and plain HTTP must not read as HTTPS.
 */
export function oauthRedirectDestination(uri: string): string {
  const target = new URL(uri);
  return `${target.protocol}//${target.host}`;
}

/**
 * A client ID Metadata Document client proves its domain by hosting its own
 * metadata. Registered clients get a generated ID, so they cannot claim one.
 */
export function oauthVerifiedDomain(clientId: string): string | null {
  if (!clientId.startsWith('https://')) return null;
  try { return new URL(clientId).host; } catch { return null; }
}

/** Only a client that proved its domain gets a logo, and only one on that same HTTPS origin. */
export function oauthClientLogoSource(client: { clientId: string; clientDiscoveryId: string | null; icon: string | null }): string | null {
  if (client.clientDiscoveryId !== 'cimd' || !client.icon || !oauthVerifiedDomain(client.clientId)) return null;
  try {
    const logo = new URL(client.icon);
    if (logo.protocol !== 'https:' || logo.username || logo.password || logo.origin !== new URL(client.clientId).origin) return null;
    return logo.href;
  } catch { return null; }
}

export function oauthClientLogoUrl(client: { clientId: string; clientDiscoveryId: string | null; icon: string | null }): string | null {
  return oauthClientLogoSource(client) ? `/api/oauth/client-logo?client_id=${encodeURIComponent(client.clientId)}` : null;
}

/** Direct SQL reads bypass Better Auth's SQLite JSON decoding. */
export function oauthStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
}
