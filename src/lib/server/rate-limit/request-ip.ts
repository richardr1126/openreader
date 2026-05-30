import type { NextRequest } from 'next/server';

/**
 * Best-effort client IP extraction for rate-limit backstops.
 *
 * Security note: `X-Forwarded-For` is a list the client can *prepend* to, so the
 * left-most entry is attacker-controlled and must never be trusted as the client
 * IP — doing so lets an attacker land every request in a fresh bucket and defeat
 * the IP backstop entirely.
 *
 * Precedence (most trustworthy first):
 *   1. x-vercel-forwarded-for — set by Vercel; inbound client copies are
 *      stripped, so it cannot be spoofed. Only consulted when running on Vercel.
 *   2. x-real-ip / cf-connecting-ip — single values set by the reverse proxy
 *      (Vercel / Cloudflare overwrite any client-supplied copy).
 *   3. x-forwarded-for — right-most hop only (the address seen by the closest
 *      trusted proxy), as a best-effort fallback for single-proxy self-hosts.
 *   4. NextRequest.ip — runtime-provided connecting address.
 *
 * IP-based limits remain a backstop only; the per-user bucket is the primary
 * control for authenticated abuse.
 */
function firstIp(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first || null;
}

export function getClientIp(req: NextRequest): string | null {
  // 1. Vercel-internal header (clients cannot set x-vercel-* — Vercel strips them).
  if (process.env.VERCEL) {
    const vercelIp = firstIp(req.headers.get('x-vercel-forwarded-for'));
    if (vercelIp) return vercelIp;
  }

  // 2. Single-value proxy headers set (and overwritten) by the edge.
  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  const cfConnectingIp = req.headers.get('cf-connecting-ip')?.trim();
  if (cfConnectingIp) return cfConnectingIp;

  // 3. Fall back to the RIGHT-most X-Forwarded-For hop (closest trusted proxy's
  //    view). Never the left-most, which the client controls.
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const parts = forwardedFor.split(',').map((part) => part.trim()).filter(Boolean);
    const rightmost = parts[parts.length - 1];
    if (rightmost) return rightmost;
  }

  // 4. Runtime-provided connecting address, when available.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reqAny = req as any;
  const ip = typeof reqAny.ip === 'string' ? (reqAny.ip as string) : null;
  return ip?.trim() || null;
}
