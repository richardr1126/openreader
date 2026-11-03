import { fetchExternal } from '@/lib/server/external-fetch';
import { oauthClientLogoSource } from './oauth-values';

const MAX_LOGO_BYTES = 256 * 1024;
const LOGO_TIMEOUT_MS = 3000;

/** The file's own bytes decide its type, so a mislabeled SVG or HTML page is never served as an image. */
export function sniffLogoContentType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** A logo is decoration, so any failure means no logo rather than an error. */
export async function fetchOAuthClientLogo(client: { clientId: string; clientDiscoveryId: string | null; icon: string | null }) {
  const source = oauthClientLogoSource(client);
  if (!source) return null;
  const origin = new URL(source).origin;
  try {
    const { body } = await fetchExternal(source, {
      maxBytes: MAX_LOGO_BYTES,
      timeoutMs: LOGO_TIMEOUT_MS,
      maxRedirects: 2,
      accept: 'image/png,image/jpeg,image/webp',
      acceptsContentType: type => /^image\/(png|jpeg|webp)\b/i.test(type),
      allowsUrl: url => url.protocol === 'https:' && url.origin === origin,
      messages: { status: status => `Logo request failed (status ${status})`, contentType: 'Unsupported logo type',
        tooLarge: 'Logo is too large', tooManyRedirects: 'Too many logo redirects' },
    });
    const contentType = sniffLogoContentType(body);
    return contentType ? { bytes: body, contentType } : null;
  } catch {
    return null;
  }
}
