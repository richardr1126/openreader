import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { readApiJson } from '@/lib/server/api/body';
import { resolveApiPrincipal } from '@/lib/server/api/principal';
import { apiCatchResponse, apiErrorResponse } from '@/lib/server/api/responses';
import { ComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import {
  activateComputeAdmission,
  finishComputeAdmission,
  reserveComputeAdmission,
} from '@/lib/server/compute-limits/admission';
import { consumeComputeUsage } from '@/lib/server/compute-limits/usage';
import { createRequestLogger } from '@/lib/server/logger';
import { parseSpeechBody, resolveApiSpeechSettings } from '@/lib/server/tts/api-speech';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SPEECH_ADMISSION_LEASE_SECONDS = 120;
// Text is capped well below this; the cap only stops oversized bodies from being buffered.
const SPEECH_MAX_BODY_BYTES = 32 * 1024;
// Used when the worker reports a busy provider without a delay of its own.
const WORKER_RETRY_AFTER_MS = 5_000;

function limited(retryAfterMs: number) {
  return apiErrorResponse(429, 'COMPUTE_ADMISSION_RATE_LIMITED', 'Speech is temporarily limited. Try again shortly.', { retryAfterMs });
}

/**
 * Speaks a short text with the caller's speech provider, model and voice and
 * returns MP3. The audio is made in worker memory and returned once: nothing
 * is added to the library. It shares interactive playback admission and
 * charges its characters like any synthesis, so it cannot bypass compute limits.
 */
export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({ route: '/api/v1/speech', request });
  try {
    const principal = await resolveApiPrincipal(request, 'audio:generate');
    if (principal instanceof Response) return principal;
    if (!isComputeWorkerAvailable()) {
      return apiErrorResponse(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for speech.');
    }
    const body = parseSpeechBody(await readApiJson(request, SPEECH_MAX_BODY_BYTES));
    if (body instanceof Response) return body;
    const settings = await resolveApiSpeechSettings(principal.userId, body);
    if (settings instanceof Response) return settings;

    const subject = { userId: principal.userId, isAnonymous: principal.isAnonymous };
    const { computeLimitPolicies: policy } = await getRuntimeConfig();
    const speechId = randomUUID();
    const admission = await reserveComputeAdmission({
      policy,
      action: 'tts_playback',
      // Not a `tts-session:` key: the worker's per-session synthesis broker must never find it.
      requestKey: `tts-speech:${speechId}`,
      subject,
    });
    if (!admission.allowed || !admission.admissionId) return limited(admission.retryAfterMs);

    let state: 'finished' | 'cancelled' = 'cancelled';
    try {
      await activateComputeAdmission({ admissionId: admission.admissionId, leaseSeconds: SPEECH_ADMISSION_LEASE_SECONDS });
      const usage = await consumeComputeUsage({
        policy,
        action: 'tts_synthesis',
        metric: 'characters',
        units: body.text.length,
        eventKey: `tts_speech:v1:${speechId}`,
        subject,
        admissionId: admission.admissionId,
      });
      if (!usage.allowed) return limited(usage.retryAfterMs);

      const result = await new ComputeWorkerClient().synthesizeTtsSpeech(
        { settings, text: body.text, userId: principal.userId },
        { signal: request.signal },
      );
      if (!result.ok) {
        logger.warn({ event: 'tts.speech.worker_rejected', status: result.status, code: result.code }, 'Worker rejected speech');
        const status = result.status === 429 ? 429 : result.status === 400 ? 400 : 502;
        const retryAfterMs = status === 429 ? result.retryAfterMs ?? WORKER_RETRY_AFTER_MS : null;
        return apiErrorResponse(status, result.code ?? 'SPEECH_FAILED', 'Speech is unavailable right now.',
          retryAfterMs ? { retryAfterMs } : {});
      }
      state = 'finished';
      return new NextResponse(result.audio, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(result.audio.byteLength),
          'Cache-Control': 'private, no-store',
        },
      });
    } finally {
      await finishComputeAdmission({ admissionId: admission.admissionId, state }).catch(() => undefined);
    }
  } catch (error) {
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    return apiCatchResponse(error, {
      logger,
      event: 'tts.speech.failed',
      msg: 'Failed to synthesize speech',
      normalize: { code: 'SPEECH_FAILED', errorClass: 'unknown' },
    });
  }
}
