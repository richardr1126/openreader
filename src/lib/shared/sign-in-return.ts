/** Links people follow from outside the app, so signing in must lead back to them. */
const RETURNABLE_PATH = /^\/(?:(?:pdf|epub|html)\/[^/]+|audiobooks\/[^/]+\/[^/]+)$/;

export function signInPathFor(pathname: string): string {
  return RETURNABLE_PATH.test(pathname) ? `/signin?returnTo=${encodeURIComponent(pathname)}` : '/signin';
}

/** Only same-origin paths the app itself sends here, so a crafted link can't redirect elsewhere. */
export function signInReturnPath(value: string | null): string {
  if (!value) return '/app';
  try {
    const url = new URL(value, 'http://localhost');
    const allowed = url.pathname === '/oauth/device' || RETURNABLE_PATH.test(url.pathname);
    return url.origin === 'http://localhost' && allowed ? `${url.pathname}${url.search}` : '/app';
  } catch { return '/app'; }
}
