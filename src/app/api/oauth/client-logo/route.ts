import { NextRequest, NextResponse } from 'next/server';
import { oauthClientLogo, oauthCookieRequest } from '@/lib/server/auth/connected-apps';
export const dynamic = 'force-dynamic';
const LOGO_CACHE_SECONDS = 24 * 60 * 60;
const MISSING_LOGO_CACHE_SECONDS = 5 * 60;

export async function GET(request: NextRequest) {
  let cacheSeconds: number | null = null;
  const response = await oauthCookieRequest(request, async () => {
    const logo = await oauthClientLogo(request.nextUrl.searchParams.get('client_id') || '');
    cacheSeconds = logo ? LOGO_CACHE_SECONDS : MISSING_LOGO_CACHE_SECONDS;
    if (!logo) return new NextResponse(null, { status: 404 });
    return new NextResponse(new Uint8Array(logo.bytes), { headers: { 'Content-Type': logo.contentType, 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox" } });
  });
  // Set after the wrapper, which marks every API response no-store. The browser's copy is what limits repeat fetches.
  if (cacheSeconds !== null) response.headers.set('Cache-Control', `private, max-age=${cacheSeconds}`);
  return response;
}
