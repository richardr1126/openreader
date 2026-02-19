import type { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

export const DEVICE_ID_COOKIE = 'or_device_id';

function isPlausibleDeviceId(value: string | undefined | null): value is string {
  if (!value) return false;
  // UUID v4 is typical here, but accept any reasonably sized token.
  return value.length >= 16 && value.length <= 128;
}

export function getDeviceId(req: NextRequest): string | null {
  const existing = req.cookies.get(DEVICE_ID_COOKIE)?.value;
  return isPlausibleDeviceId(existing) ? existing : null;
}

/**
 * Returns a stable anonymous device identifier.
 *
 * This survives localStorage/IndexedDB clears, but not full cookie clears.
 */
export function getOrCreateDeviceId(req: NextRequest): { deviceId: string; didCreate: boolean } {
  const existing = getDeviceId(req);
  if (existing) return { deviceId: existing, didCreate: false };
  return { deviceId: randomUUID(), didCreate: true };
}

// NextResponse.cookies.set has an overloaded signature; keep this loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setDeviceIdCookie(res: { cookies: { set: (...args: any[]) => any } }, deviceId: string): void {
  res.cookies.set({
    name: DEVICE_ID_COOKIE,
    value: deviceId,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // ~2 years
    maxAge: 60 * 60 * 24 * 365 * 2,
  });
}
