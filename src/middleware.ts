import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Better Auth session cookie name (default prefix + session_token).
 * @see https://www.better-auth.com/docs/concepts/session-management
 */
const SESSION_COOKIE = 'better-auth.session_token';
const SECURE_SESSION_COOKIE = '__Secure-better-auth.session_token';
const SESSION_COOKIE_NAMES = [SESSION_COOKIE, SECURE_SESSION_COOKIE];

/**
 * Routes that never require a session cookie.
 * Static assets and Next.js internals are excluded via the matcher config below.
 */
const PUBLIC_PATH_PREFIXES = [
  '/api/auth',   // Better Auth endpoints (sign-in, sign-up, callbacks, etc.)
  '/signin',
  '/signup',
  '/privacy',
];

function isPublicPath(pathname: string): boolean {
  // Root landing page
  if (pathname === '/') return true;

  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isAuthEnabled(): boolean {
  return !!(process.env.AUTH_SECRET && process.env.BASE_URL);
}

function isAnonymousAuthEnabled(): boolean {
  if (!isAuthEnabled()) return false;
  const raw = process.env.USE_ANONYMOUS_AUTH_SESSIONS;
  return raw?.trim().toLowerCase() === 'true';
}

export function middleware(request: NextRequest) {
  // When auth is disabled entirely, let everything through.
  if (!isAuthEnabled()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Fast-path redirect for signed-in users hitting the public landing page.
  // This avoids extra server work in the landing page render path.
  if (pathname === '/' && request.nextUrl.searchParams.get('redirect') !== 'false') {
    const hasSession = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));
    if (hasSession) {
      const appUrl = request.nextUrl.clone();
      appUrl.pathname = '/app';
      appUrl.search = '';
      return NextResponse.redirect(appUrl);
    }
  }

  // Public routes are always accessible.
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // When anonymous auth is enabled, unauthenticated users need to reach
  // the page so AuthLoader.tsx can bootstrap an anonymous session client-side.
  if (isAnonymousAuthEnabled()) {
    return NextResponse.next();
  }

  // Check for the presence of a session cookie.
  const hasSession = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));

  if (!hasSession) {
    // API routes get a 401 instead of a redirect.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Page routes redirect to sign-in.
    const signInUrl = request.nextUrl.clone();
    signInUrl.pathname = '/signin';
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

/**
 * Match all routes except static assets and Next.js internals.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|icon\\.png|icon\\.svg|apple-icon\\.png|manifest\\.json).*)',
  ],
};
