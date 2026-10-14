export function tryGetOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

const DEFAULT_SITE_ORIGIN = 'https://openreader.richardr.dev';

/** Canonical public origin for metadata, sitemaps, and structured data. */
export function getSiteOrigin(): string {
  return tryGetOrigin(process.env.BASE_URL) || DEFAULT_SITE_ORIGIN;
}
