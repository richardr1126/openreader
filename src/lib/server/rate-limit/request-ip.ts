import type { NextRequest } from 'next/server';

/**
 * Best-effort client IP extraction that works on Vercel and typical reverse proxies.
 *
 * Note: IP-based limits are a backstop only; they are not perfectly reliable.
 */
export function getClientIp(req: NextRequest): string | null {
  // Standard proxy header. Vercel also sets this.
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  // Some proxies use this.
  const cfConnectingIp = req.headers.get('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp.trim();

  // NextRequest may expose ip depending on runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reqAny = req as any;
  const ip = typeof reqAny.ip === 'string' ? (reqAny.ip as string) : null;
  return ip?.trim() || null;
}
