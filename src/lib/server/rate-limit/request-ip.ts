import { isIP } from 'node:net';
import type { NextRequest } from 'next/server';

/**
 * Best-effort client IP extraction for account-creation caps.
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
 * A value that isn't an IP address is skipped in favor of the next source.
 * Callers hash this value before persistence. Compute limits key on the user.
 */
/** A source wins only with a real address, so a junk header can't blank out the cap. */
function validIp(value: string | null | undefined): string | null {
  const ip = value?.trim();
  return ip && isIP(ip.split('%')[0]) ? ip : null;
}

export function getClientIp(req: Pick<NextRequest, 'headers'>): string | null {
  // 1. Vercel-internal header (clients cannot set x-vercel-* — Vercel strips them).
  const vercelIp = process.env.VERCEL ? validIp(req.headers.get('x-vercel-forwarded-for')?.split(',')[0]) : null;
  // 2. Single-value proxy headers set (and overwritten) by the edge.
  // 3. The RIGHT-most X-Forwarded-For hop (closest trusted proxy's view), never the client-controlled left-most.
  const forwarded = req.headers.get('x-forwarded-for')?.split(',').map((part) => part.trim()).filter(Boolean);
  // 4. Runtime-provided connecting address, when available.
  const runtimeIp = (req as { ip?: unknown }).ip;
  return vercelIp
    ?? validIp(req.headers.get('x-real-ip'))
    ?? validIp(req.headers.get('cf-connecting-ip'))
    ?? validIp(forwarded?.at(-1))
    ?? validIp(typeof runtimeIp === 'string' ? runtimeIp : null);
}
