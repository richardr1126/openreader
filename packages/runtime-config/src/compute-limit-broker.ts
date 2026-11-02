/** Stable storage cap codes and their text, shared by the app, worker and browser. */
export const STORAGE_LIMIT_MESSAGES = {
  ACCOUNT_STORAGE_LIMIT_REACHED: 'Account storage limit reached.',
  GUEST_STORAGE_LIMIT_REACHED: 'Guest storage limit reached.',
  GUEST_STORAGE_POOL_FULL: 'Total guest storage limit reached.',
} as const;
export type StorageLimitCode = keyof typeof STORAGE_LIMIT_MESSAGES;
export const isStorageLimitCode = (value: unknown): value is StorageLimitCode =>
  typeof value === 'string' && Object.hasOwn(STORAGE_LIMIT_MESSAGES, value);

export interface TtsSynthesisConsumeRequest {
  action: 'tts_synthesis';
  sessionId: string;
  userId: string;
  eventKey: string;
  characters: number;
}

export interface TtsSynthesisConsumeResponse {
  allowed: boolean;
  charged: boolean;
  idempotent: boolean;
  retryAfterMs: number;
  storageLimit?: StorageLimitCode;
  usage: {
    used: number;
    limit: number;
    remaining: number;
    resetAt: number;
  } | null;
}

export interface ComputeLimitPolicyBrokerResponse {
  policy: import('./compute-limits').ComputeLimitPolicyDocument;
  policyVersion: number;
}

export interface ComputeAdmissionTerminalRequest {
  operationId: string;
  state: 'succeeded' | 'failed' | 'cancelled';
}

function isNonemptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function parseTtsSynthesisConsumeRequest(value: unknown): TtsSynthesisConsumeRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5
    || record.action !== 'tts_synthesis'
    || !isNonemptyBoundedString(record.sessionId, 256)
    || !isNonemptyBoundedString(record.userId, 256)
    || !isNonemptyBoundedString(record.eventKey, 512)
    || typeof record.characters !== 'number'
    || !Number.isSafeInteger(record.characters)
    || record.characters <= 0
  ) return null;
  return {
    action: 'tts_synthesis',
    sessionId: record.sessionId,
    userId: record.userId,
    eventKey: record.eventKey,
    characters: record.characters,
  };
}

export function parseComputeAdmissionTerminalRequest(value: unknown): ComputeAdmissionTerminalRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2
    || !isNonemptyBoundedString(record.operationId, 512)
    || (record.state !== 'succeeded' && record.state !== 'failed' && record.state !== 'cancelled')) return null;
  return { operationId: record.operationId, state: record.state };
}

export function parseTtsSynthesisConsumeResponse(value: unknown): TtsSynthesisConsumeResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== (record.storageLimit === undefined ? 5 : 6)
    || (record.storageLimit !== undefined && !isStorageLimitCode(record.storageLimit))
    || typeof record.allowed !== 'boolean'
    || typeof record.charged !== 'boolean'
    || typeof record.idempotent !== 'boolean'
    || typeof record.retryAfterMs !== 'number'
    || !Number.isSafeInteger(record.retryAfterMs)
    || record.retryAfterMs < 0
  ) return null;
  let usage: TtsSynthesisConsumeResponse['usage'] = null;
  if (record.usage !== null) {
    if (!record.usage || typeof record.usage !== 'object' || Array.isArray(record.usage)) return null;
    const raw = record.usage as Record<string, unknown>;
    if (Object.keys(raw).length !== 4 || !['used', 'limit', 'remaining', 'resetAt'].every((key) => (
      typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0
    ))) return null;
    usage = {
      used: raw.used as number,
      limit: raw.limit as number,
      remaining: raw.remaining as number,
      resetAt: raw.resetAt as number,
    };
  }
  return {
    allowed: record.allowed,
    charged: record.charged,
    idempotent: record.idempotent,
    retryAfterMs: record.retryAfterMs,
    usage,
    ...(isStorageLimitCode(record.storageLimit) ? { storageLimit: record.storageLimit } : {}),
  };
}
