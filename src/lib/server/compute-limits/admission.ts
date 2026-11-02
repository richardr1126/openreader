import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import { computeLimitAdmissions, computeLimitBuckets } from '@openreader/database/schema';
import type {
  ComputeAction,
  ComputeLimitPolicyDocument,
  ComputeLimitScope,
} from '@openreader/runtime-config/compute-limits';
import {
  computePolicyVersion,
  fixedWindow,
  resolveComputeScope,
  type ComputeLimitSubject,
} from './policy';

export type ComputeAdmissionState = 'reserved' | 'active' | 'finished' | 'cancelled';

const TTS_PLAYBACK_ADMISSION_WINDOW_MS = 30 * 60 * 1000;
const INLINE_EXPIRY_RECONCILIATION_LIMIT = 10;

type ChargedActiveScope = { scope: ComputeLimitScope; scopeKey: string };

export function buildTtsPlaybackAdmissionRequestKey(sessionId: string, nowMs: number): string {
  return `tts-session:${sessionId}:${Math.floor(nowMs / TTS_PLAYBACK_ADMISSION_WINDOW_MS)}`;
}

export function isTtsPlaybackAdmissionForSession(requestKey: string, sessionId: string): boolean {
  return requestKey.startsWith(`tts-session:${sessionId}:`);
}

export interface ComputeAdmissionDecision {
  allowed: boolean;
  admissionId: string | null;
  state: ComputeAdmissionState | null;
  idempotent: boolean;
  retryAfterMs: number;
}

class AdmissionDenied extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Compute admission limit reached');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safeDb = () => db as any;
type DbTransactionConnection = Parameters<Parameters<typeof runInDbTransaction>[0]>[0];

function rowsAffected(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const result = value as Record<string, unknown>;
  if (typeof result.rowCount === 'number') return result.rowCount;
  if (typeof result.changes === 'number') return result.changes;
  return 0;
}

function parseChargedActiveScopes(value: string): ChargedActiveScope[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => (
    entry && typeof entry === 'object'
      && ['user', 'site'].includes(
        String((entry as Record<string, unknown>).scope),
      )
      && typeof (entry as Record<string, unknown>).scopeKey === 'string'
  ))) {
    throw new Error('Compute admission active scopes are invalid');
  }
  return parsed as ChargedActiveScope[];
}

async function decrementActiveGauge(conn: DbTransactionConnection, input: {
  scope: ComputeLimitScope;
  scopeKey: string;
  action: ComputeAction;
  nowMs: number;
}): Promise<void> {
  await conn.update(computeLimitBuckets).set({
    used: sql`case when ${computeLimitBuckets.used} > 0 then ${computeLimitBuckets.used} - 1 else 0 end`,
    updatedAt: input.nowMs,
  }).where(and(
    eq(computeLimitBuckets.scopeType, input.scope),
    eq(computeLimitBuckets.scopeKey, input.scopeKey),
    eq(computeLimitBuckets.action, input.action),
    eq(computeLimitBuckets.metric, 'active'),
    eq(computeLimitBuckets.windowStart, 0),
  ));
}

async function decrementAdmissionActiveGauges(conn: DbTransactionConnection, input: {
  activeScopesJson: string;
  action: ComputeAction;
  nowMs: number;
}): Promise<void> {
  for (const scope of parseChargedActiveScopes(input.activeScopesJson)) {
    await decrementActiveGauge(conn, { ...scope, action: input.action, nowMs: input.nowMs });
  }
}

async function reconcileExpiredAdmissions(
  conn: DbTransactionConnection,
  action: ComputeAction,
  nowMs: number,
  userId?: string,
  limit = 100,
): Promise<void> {
  const expired = await conn.select({
    id: computeLimitAdmissions.id,
    activeScopesJson: computeLimitAdmissions.activeScopesJson,
  }).from(computeLimitAdmissions).where(and(
    eq(computeLimitAdmissions.action, action),
    inArray(computeLimitAdmissions.state, ['reserved', 'active']),
    lte(computeLimitAdmissions.leaseExpiresAt, nowMs),
    userId ? eq(computeLimitAdmissions.userId, userId) : undefined,
  )).limit(limit);

  for (const row of expired as Array<{
    id: string;
    activeScopesJson: string;
  }>) {
    const updated = await conn.update(computeLimitAdmissions).set({
      state: 'cancelled',
      finishedAt: nowMs,
    }).where(and(
      eq(computeLimitAdmissions.id, row.id),
      inArray(computeLimitAdmissions.state, ['reserved', 'active']),
      lte(computeLimitAdmissions.leaseExpiresAt, nowMs),
    ));
    if (rowsAffected(updated) === 0) continue;
    await decrementAdmissionActiveGauges(conn, {
      activeScopesJson: row.activeScopesJson,
      action,
      nowMs,
    });
  }
}

export async function reconcileExpiredComputeAdmissions(
  action: Exclude<ComputeAction, 'tts_synthesis'>,
  nowMs = Date.now(),
): Promise<void> {
  await runInDbTransaction((conn) => reconcileExpiredAdmissions(conn, action, nowMs));
}

async function existingAdmission(
  userId: string,
  action: ComputeAction,
  requestKey: string,
): Promise<{ id: string; state: ComputeAdmissionState; leaseExpiresAt: number } | null> {
  const rows = await safeDb().select({
    id: computeLimitAdmissions.id,
    state: computeLimitAdmissions.state,
    leaseExpiresAt: computeLimitAdmissions.leaseExpiresAt,
  }).from(computeLimitAdmissions).where(and(
    eq(computeLimitAdmissions.userId, userId),
    eq(computeLimitAdmissions.action, action),
    eq(computeLimitAdmissions.requestKey, requestKey),
  )).limit(1);
  const row = rows[0];
  return row ? {
    id: String(row.id),
    state: row.state as ComputeAdmissionState,
    leaseExpiresAt: Number(row.leaseExpiresAt),
  } : null;
}

export async function reserveComputeAdmission(input: {
  policy: ComputeLimitPolicyDocument;
  action: Exclude<ComputeAction, 'tts_synthesis'>;
  requestKey: string;
  subject: ComputeLimitSubject;
  nowMs?: number;
}): Promise<ComputeAdmissionDecision> {
  if (!input.requestKey.trim() || input.requestKey.length > 512) {
    throw new Error('Compute admission request key is invalid');
  }
  const nowMs = input.nowMs ?? Date.now();
  const existing = await existingAdmission(input.subject.userId, input.action, input.requestKey);
  if (existing && existing.leaseExpiresAt > nowMs && (existing.state === 'reserved' || existing.state === 'active')) {
    return {
      allowed: true,
      admissionId: existing.id,
      state: existing.state,
      idempotent: true,
      retryAfterMs: 0,
    };
  }

  const actionPolicy = input.policy.actions[input.action];
  const leaseSeconds = Math.max(60, ...actionPolicy.admission.active.map((limit) => limit.leaseSeconds));
  const admissionId = randomUUID();
  const counters: Array<{
    scope: ComputeLimitScope;
    scopeKey: string;
    metric: 'starts' | 'active';
    windowStart: number;
    windowEnd: number;
    limit: number;
  }> = [];
  for (const windowPolicy of actionPolicy.admission.windows) {
    const scope = resolveComputeScope(windowPolicy.scope, input.subject);
    if (!scope) continue;
    const window = fixedWindow(nowMs, windowPolicy.windowSeconds);
    counters.push({
      scope: scope.scope,
      scopeKey: scope.key,
      metric: 'starts',
      windowStart: window.startMs,
      windowEnd: window.endMs,
      limit: windowPolicy.limit,
    });
  }
  for (const activePolicy of actionPolicy.admission.active) {
    const scope = resolveComputeScope(activePolicy.scope, input.subject);
    if (!scope) continue;
    counters.push({
      scope: scope.scope,
      scopeKey: scope.key,
      metric: 'active',
      windowStart: 0,
      windowEnd: 0,
      limit: activePolicy.limit,
    });
  }
  const activeScopesJson = JSON.stringify(!actionPolicy.enabled ? [] : counters
    .filter((counter) => counter.metric === 'active')
    .map(({ scope, scopeKey }) => ({ scope, scopeKey })));
  try {
    await runInDbTransaction(async (conn) => {
      const matchingRows = await conn.select({
        id: computeLimitAdmissions.id,
        state: computeLimitAdmissions.state,
        activeScopesJson: computeLimitAdmissions.activeScopesJson,
        leaseExpiresAt: computeLimitAdmissions.leaseExpiresAt,
      }).from(computeLimitAdmissions).where(and(
        eq(computeLimitAdmissions.userId, input.subject.userId),
        eq(computeLimitAdmissions.action, input.action),
        eq(computeLimitAdmissions.requestKey, input.requestKey),
      )).limit(1);
      const matching = matchingRows[0];
      if (matching && (matching.state === 'reserved' || matching.state === 'active')) {
        if (Number(matching.leaseExpiresAt) > nowMs) return;
        const expired = await conn.update(computeLimitAdmissions).set({
          state: 'cancelled',
          finishedAt: nowMs,
        }).where(and(
          eq(computeLimitAdmissions.id, matching.id),
          inArray(computeLimitAdmissions.state, ['reserved', 'active']),
          lte(computeLimitAdmissions.leaseExpiresAt, nowMs),
        ));
        if (rowsAffected(expired) > 0) {
          await decrementAdmissionActiveGauges(conn, {
            activeScopesJson: String(matching.activeScopesJson),
            action: input.action,
            nowMs,
          });
        }
      }
      await conn.delete(computeLimitAdmissions).where(and(
        eq(computeLimitAdmissions.userId, input.subject.userId),
        eq(computeLimitAdmissions.action, input.action),
        eq(computeLimitAdmissions.requestKey, input.requestKey),
        inArray(computeLimitAdmissions.state, ['finished', 'cancelled']),
      ));
      const inserted = await conn.insert(computeLimitAdmissions).values({
        id: admissionId,
        requestKey: input.requestKey,
        userId: input.subject.userId,
        isAnonymous: input.subject.isAnonymous,
        action: input.action,
        state: 'reserved',
        operationId: null,
        activeScopesJson,
        policyVersion: computePolicyVersion(input.policy),
        createdAt: nowMs,
        activatedAt: null,
        finishedAt: null,
        leaseExpiresAt: nowMs + leaseSeconds * 1000,
      }).onConflictDoNothing({
        target: [
          computeLimitAdmissions.userId,
          computeLimitAdmissions.action,
          computeLimitAdmissions.requestKey,
        ],
      });
      if (rowsAffected(inserted) === 0) return;

      if (!actionPolicy.enabled) return;
      for (const counter of counters) {
        await conn.insert(computeLimitBuckets).values({
          scopeType: counter.scope,
          scopeKey: counter.scopeKey,
          action: input.action,
          metric: counter.metric,
          windowStart: counter.windowStart,
          windowEnd: counter.windowEnd,
          used: 0,
          updatedAt: nowMs,
        }).onConflictDoNothing({
          target: [
            computeLimitBuckets.scopeType,
            computeLimitBuckets.scopeKey,
            computeLimitBuckets.action,
            computeLimitBuckets.metric,
            computeLimitBuckets.windowStart,
          ],
        });
        const baseWhere = and(
          eq(computeLimitBuckets.scopeType, counter.scope),
          eq(computeLimitBuckets.scopeKey, counter.scopeKey),
          eq(computeLimitBuckets.action, input.action),
          eq(computeLimitBuckets.metric, counter.metric),
          eq(computeLimitBuckets.windowStart, counter.windowStart),
        );
        const incrementCounter = () => conn.update(computeLimitBuckets).set({
          used: sql`${computeLimitBuckets.used} + 1`,
          updatedAt: nowMs,
        }).where(and(baseWhere, sql`${computeLimitBuckets.used} < ${counter.limit}`));
        let updated = await incrementCounter();
        if (rowsAffected(updated) === 0 && counter.metric === 'active') {
          await reconcileExpiredAdmissions(
            conn,
            input.action,
            nowMs,
            counter.scope === 'user' ? input.subject.userId : undefined,
            INLINE_EXPIRY_RECONCILIATION_LIMIT,
          );
          updated = await incrementCounter();
        }
        if (rowsAffected(updated) === 0) {
          const retryAfterMs = counter.metric === 'starts'
            ? Math.max(0, counter.windowEnd - nowMs)
            : leaseSeconds * 1000;
          throw new AdmissionDenied(retryAfterMs);
        }
      }
    });
  } catch (error) {
    if (!(error instanceof AdmissionDenied)) throw error;
    return {
      allowed: false,
      admissionId: null,
      state: null,
      idempotent: false,
      retryAfterMs: error.retryAfterMs,
    };
  }

  const resolved = await existingAdmission(input.subject.userId, input.action, input.requestKey);
  return {
    allowed: true,
    admissionId: resolved?.id ?? admissionId,
    state: resolved?.state ?? 'reserved',
    idempotent: resolved?.id !== admissionId,
    retryAfterMs: 0,
  };
}

export async function activateComputeAdmission(input: {
  admissionId: string;
  operationId?: string | null;
  leaseSeconds: number;
  nowMs?: number;
}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();
  await safeDb().update(computeLimitAdmissions).set({
    state: 'active',
    operationId: input.operationId ?? null,
    activatedAt: sql`coalesce(${computeLimitAdmissions.activatedAt}, ${nowMs})`,
    leaseExpiresAt: nowMs + Math.max(60, input.leaseSeconds) * 1000,
  }).where(and(
    eq(computeLimitAdmissions.id, input.admissionId),
    inArray(computeLimitAdmissions.state, ['reserved', 'active']),
  ));
}

export async function touchComputeAdmission(input: {
  admissionId: string;
  leaseSeconds: number;
  nowMs?: number;
}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();
  await safeDb().update(computeLimitAdmissions).set({
    leaseExpiresAt: nowMs + Math.max(60, input.leaseSeconds) * 1000,
  }).where(and(
    eq(computeLimitAdmissions.id, input.admissionId),
    inArray(computeLimitAdmissions.state, ['reserved', 'active']),
  ));
}

export async function finishComputeAdmission(input: {
  admissionId: string;
  state: Extract<ComputeAdmissionState, 'finished' | 'cancelled'>;
  nowMs?: number;
}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();
  await runInDbTransaction(async (conn) => {
    const rows = await conn.select({
      action: computeLimitAdmissions.action,
      activeScopesJson: computeLimitAdmissions.activeScopesJson,
    }).from(computeLimitAdmissions).where(and(
      eq(computeLimitAdmissions.id, input.admissionId),
      inArray(computeLimitAdmissions.state, ['reserved', 'active']),
    )).limit(1);
    const admission = rows[0];
    if (!admission) return;
    const updated = await conn.update(computeLimitAdmissions).set({
      state: input.state,
      finishedAt: nowMs,
    }).where(and(
      eq(computeLimitAdmissions.id, input.admissionId),
      inArray(computeLimitAdmissions.state, ['reserved', 'active']),
    ));
    if (rowsAffected(updated) === 0) return;
    const action = admission.action as ComputeAction;
    await decrementAdmissionActiveGauges(conn, {
      activeScopesJson: String(admission.activeScopesJson),
      action,
      nowMs,
    });
  });
}
