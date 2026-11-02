import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/** Canonical addresses prevent alternate IPv6 spellings from bypassing /64 caps. */
export function normalizeIp(value: string): string | null {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const parts = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  // IPv4-mapped addresses share the IPv4 bucket.
  if (parts.slice(0, 5).every((part) => Number.parseInt(part, 16) === 0) && parts[5] === 'ffff') {
    const words = parts.slice(6).map((part) => Number.parseInt(part, 16));
    return words.flatMap((word) => [word >> 8, word & 255]).join('.');
  }
  return `${parts.slice(0, 4).map((part) => Number.parseInt(part, 16).toString(16)).join(':')}::/64`;
}

export function hashIp(value: string | null | undefined, label: 'session' | 'account-creation' | 'guest-creation'): string | null {
  const normalized = value ? normalizeIp(value.trim()) : null;
  if (!normalized) return null;
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error('AUTH_SECRET is required to hash IP addresses');
  return createHmac('sha256', secret).update(`openreader:ip:${label}:v1\0${normalized}`).digest('hex');
}
