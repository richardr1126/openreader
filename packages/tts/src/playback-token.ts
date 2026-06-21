import { createHmac, timingSafeEqual } from 'node:crypto';

export type TtsPlaybackTokenPayload = {
  sessionId: string;
  userId: string;
  storageUserId: string;
  documentId: string;
  exp: number;
};

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64');
}

function sign(data: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(data).digest());
}

function isPayload(value: unknown): value is TtsPlaybackTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.sessionId === 'string'
    && typeof rec.userId === 'string'
    && typeof rec.storageUserId === 'string'
    && typeof rec.documentId === 'string'
    && Number.isFinite(Number(rec.exp));
}

export function createTtsPlaybackToken(payload: TtsPlaybackTokenPayload, secret: string): string {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) throw new Error('TTS playback token secret is required');
  const body = base64UrlEncode(JSON.stringify({
    sessionId: payload.sessionId,
    userId: payload.userId,
    storageUserId: payload.storageUserId,
    documentId: payload.documentId,
    exp: Math.floor(payload.exp),
  }));
  return `${body}.${sign(body, normalizedSecret)}`;
}

export function verifyTtsPlaybackToken(
  token: string,
  secret: string,
  options?: { nowMs?: number },
): TtsPlaybackTokenPayload {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) throw new Error('TTS playback token secret is required');
  const [body, signature, extra] = token.trim().split('.');
  if (!body || !signature || extra !== undefined) throw new Error('Invalid playback token');
  const expected = sign(body, normalizedSecret);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Invalid playback token signature');
  }
  const parsed = JSON.parse(base64UrlDecode(body).toString('utf8')) as unknown;
  if (!isPayload(parsed)) throw new Error('Invalid playback token payload');
  const exp = Math.floor(Number(parsed.exp));
  if (exp <= (options?.nowMs ?? Date.now())) throw new Error('Playback token expired');
  return {
    sessionId: parsed.sessionId,
    userId: parsed.userId,
    storageUserId: parsed.storageUserId,
    documentId: parsed.documentId,
    exp,
  };
}
