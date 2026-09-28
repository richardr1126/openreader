import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { computeLimitAdmissions } from '@openreader/database/schema';
import {
  parseTtsSynthesisConsumeRequest,
  type TtsSynthesisConsumeResponse,
} from '@openreader/runtime-config/compute-limit-broker';
import { authenticateCredentialBrokerRequest } from '@/lib/server/compute-worker/credential-broker-auth';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import {
  isTtsPlaybackAdmissionForSession,
  touchComputeAdmission,
} from '@/lib/server/compute-limits/admission';
import { consumeComputeUsage } from '@/lib/server/compute-limits/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
};
const MAX_REQUEST_BYTES = 2_048;

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function error(status: number, code: string): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: NO_STORE_HEADERS });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticateCredentialBrokerRequest(request.headers.get('authorization'));
  if (auth === 'unconfigured') return error(503, 'BROKER_UNAVAILABLE');
  if (auth !== 'authorized') return error(401, 'BROKER_UNAUTHORIZED');

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) return error(400, 'REQUEST_INVALID');
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody) as unknown;
  } catch {
    return error(400, 'REQUEST_INVALID');
  }
  const parsed = parseTtsSynthesisConsumeRequest(raw);
  if (!parsed) return error(400, 'REQUEST_INVALID');

  const nowMs = Date.now();
  const admissions = await db.select({
    id: computeLimitAdmissions.id,
    userId: computeLimitAdmissions.userId,
    isAnonymous: computeLimitAdmissions.isAnonymous,
    deviceScopeKey: computeLimitAdmissions.deviceScopeKey,
    ipScopeKey: computeLimitAdmissions.ipScopeKey,
    requestKey: computeLimitAdmissions.requestKey,
    action: computeLimitAdmissions.action,
  }).from(computeLimitAdmissions).where(and(
    eq(computeLimitAdmissions.userId, parsed.userId),
    // Live playback and whole-document export runs both synthesize under
    // their session admission.
    inArray(computeLimitAdmissions.action, ['tts_playback', 'tts_playback_document']),
    inArray(computeLimitAdmissions.state, ['reserved', 'active']),
    gt(computeLimitAdmissions.leaseExpiresAt, nowMs),
    sql`${computeLimitAdmissions.requestKey} like ${`${escapeSqlLike(`tts-session:${parsed.sessionId}:`)}%`} escape '\\'`,
  )).orderBy(desc(computeLimitAdmissions.createdAt)).limit(50);
  const admission = admissions.find((row: (typeof admissions)[number]) => (
    isTtsPlaybackAdmissionForSession(row.requestKey, parsed.sessionId)
  ));
  if (!admission) return error(404, 'ADMISSION_UNAVAILABLE');

  const runtimeConfig = await getRuntimeConfig();
  const leaseSeconds = Math.max(
    60,
    ...runtimeConfig.computeLimitPolicies.actions[
      admission.action === 'tts_playback_document' ? 'tts_playback_document' : 'tts_playback'
    ].admission.active.map((limit) => limit.leaseSeconds),
  );
  await touchComputeAdmission({ admissionId: admission.id, leaseSeconds, nowMs });
  const decision = await consumeComputeUsage({
    policy: runtimeConfig.computeLimitPolicies,
    action: 'tts_synthesis',
    metric: 'characters',
    units: parsed.characters,
    eventKey: parsed.eventKey,
    admissionId: admission.id,
    subject: {
      userId: admission.userId,
      isAnonymous: Boolean(admission.isAnonymous),
      deviceScopeKey: admission.deviceScopeKey,
      ipScopeKey: admission.ipScopeKey,
    },
    nowMs,
  });
  const binding = decision.buckets.reduce<(typeof decision.buckets)[number] | null>(
    (current, bucket) => !current || bucket.remaining < current.remaining ? bucket : current,
    null,
  );
  const response: TtsSynthesisConsumeResponse = {
    allowed: decision.allowed,
    charged: decision.charged,
    idempotent: decision.idempotent,
    retryAfterMs: decision.retryAfterMs,
    usage: binding ? {
      used: binding.used,
      limit: binding.limit,
      remaining: binding.remaining,
      resetAt: binding.resetAt,
    } : null,
  };
  return NextResponse.json(response, { headers: NO_STORE_HEADERS });
}
