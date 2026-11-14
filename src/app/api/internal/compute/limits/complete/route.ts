import { after, NextRequest, NextResponse } from 'next/server';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { db } from '@openreader/database';
import { computeLimitAdmissions } from '@openreader/database/schema';
import { COMPUTE_ADMISSION_ACTION_HEADER, COMPUTE_ADMISSION_FINISHED_AT_HEADER, isComputeTerminalAdmissionAction, parseComputeAdmissionTerminalRequest } from '@openreader/runtime-config/compute-limit-broker';
import { authenticateCredentialBrokerRequest } from '@/lib/server/compute-worker/credential-broker-auth';
import { advanceAudiobooksAfterOperation } from '@/lib/server/audiobooks/audiobooks';
import { finishComputeAdmission } from '@/lib/server/compute-limits/admission';
import { logDegraded } from '@/lib/server/errors/logging';
import { serverLogger } from '@/lib/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The operations an audiobook waits on before its next step can start.
const AUDIOBOOK_STEP_ACTIONS = new Set(['tts_playback_plan', 'tts_playback_document', 'tts_playback_export']);

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' };

function error(status: number, code: string): NextResponse {
  return NextResponse.json({ error: code }, { status, headers: NO_STORE_HEADERS });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticateCredentialBrokerRequest(request.headers.get('authorization'));
  if (auth === 'unconfigured') return error(503, 'BROKER_UNAVAILABLE');
  if (auth !== 'authorized') return error(401, 'BROKER_UNAUTHORIZED');
  const parsed = parseComputeAdmissionTerminalRequest(await request.json().catch(() => null));
  if (!parsed) return error(400, 'REQUEST_INVALID');
  const admissionAction = request.headers.get(COMPUTE_ADMISSION_ACTION_HEADER);
  if (admissionAction !== null && !isComputeTerminalAdmissionAction(admissionAction)) return error(400, 'REQUEST_INVALID');
  const finishedAtHeader = request.headers.get(COMPUTE_ADMISSION_FINISHED_AT_HEADER);
  const finishedAt = finishedAtHeader === null ? undefined : Number(finishedAtHeader);
  if (finishedAt !== undefined && (!Number.isSafeInteger(finishedAt) || finishedAt <= 0)) return error(400, 'REQUEST_INVALID');
  // Read unlinked admissions first so a link racing this request is seen in
  // at least one query. An active admission is reserved before publishing.
  const awaitingLink = admissionAction === null ? [] : await db.select({ id: computeLimitAdmissions.id })
    .from(computeLimitAdmissions).where(and(
      eq(computeLimitAdmissions.action, admissionAction),
      eq(computeLimitAdmissions.state, 'active'),
      isNull(computeLimitAdmissions.operationId),
      gt(computeLimitAdmissions.leaseExpiresAt, Date.now()),
      // Admissions created after completion can discover the terminal state
      // directly if they reuse this operation.
      finishedAt === undefined ? undefined : lte(computeLimitAdmissions.activatedAt, finishedAt),
    )).limit(1);
  const rows = await db.select({
    id: computeLimitAdmissions.id,
    userId: computeLimitAdmissions.userId,
    action: computeLimitAdmissions.action,
  })
    .from(computeLimitAdmissions)
    .where(eq(computeLimitAdmissions.operationId, parsed.operationId))
    .limit(100) as Array<{ id: string; userId: string; action: string }>;
  for (const row of rows) {
    await finishComputeAdmission({
      admissionId: row.id,
      state: parsed.state === 'succeeded' ? 'finished' : 'cancelled',
    });
  }
  const audiobookStep = rows.find((row) => AUDIOBOOK_STEP_ACTIONS.has(row.action));
  // The worker awaits this callback before acknowledging its job, so the next
  // step runs after the response. If this is lost, the next GET advances it.
  if (audiobookStep) {
    after(() => advanceAudiobooksAfterOperation(parsed.operationId, audiobookStep.userId).catch((advanceError: unknown) => {
      logDegraded(serverLogger, {
        event: 'audiobooks.advance_signal.failed',
        msg: 'Failed to advance audiobooks after a worker operation finished',
        step: 'advance_audiobooks',
        context: { operationId: parsed.operationId },
        error: advanceError,
      });
    }));
  }
  return awaitingLink.length > 0
    ? error(503, 'ADMISSION_LINK_PENDING')
    : new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
}
