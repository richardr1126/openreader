import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  ComputeWorkerClient,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { parseTtsSegmentSettings } from '@/lib/server/tts/playback-request';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import {
  activateComputeAdmission,
  finishComputeAdmission,
  reserveComputeAdmission,
} from '@/lib/server/compute-limits/admission';
import { consumeComputeUsage } from '@/lib/server/compute-limits/usage';
import { TTS_VOICE_PREVIEW_MAX_TEXT_CHARS } from '@/lib/shared/tts-voice-preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PREVIEW_ADMISSION_LEASE_SECONDS = 60;

function rateLimited(retryAfterMs: number) {
  return NextResponse.json({
    error: 'Voice previews are temporarily limited. Please try again shortly.',
    code: 'COMPUTE_ADMISSION_RATE_LIMITED',
    retryAfterMs,
  }, {
    status: 429,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
  });
}

function parsePreviewBody(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const settings = parseTtsSegmentSettings(rec.settings);
  const text = typeof rec.text === 'string' ? rec.text.trim() : '';
  if (!settings || !text || text.length > TTS_VOICE_PREVIEW_MAX_TEXT_CHARS) return null;
  if (!settings.providerRef.trim() || !settings.ttsModel.trim() || !settings.voice.trim()) return null;
  if (settings.nativeSpeed < 0.5 || settings.nativeSpeed > 3) return null;
  return { settings, text };
}

/**
 * Speaks one short sample with a draft voice and model speed. The audio is
 * synthesized in worker memory and returned once: it never enters the
 * document's canonical timeline or segment cache. A preview shares the
 * interactive playback admission budget and charges its characters like
 * playback synthesis, so it cannot bypass compute limits.
 */
export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({ route: '/api/tts/voice-preview', request });
  try {
    const ctx = await requireAuthContext(request);
    if (ctx instanceof Response) return ctx;
    const userId = ctx.userId as string;

    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for voice previews.' },
        { status: 503 },
      );
    }

    const parsed = parsePreviewBody(await request.json().catch(() => null));
    if (!parsed) return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });

    const isAnonymous = Boolean((ctx.user as { isAnonymous?: boolean } | null)?.isAnonymous);
    const device = isAnonymous ? getOrCreateDeviceId(request) : null;
    const subject = {
      userId,
      isAnonymous,
      deviceId: device?.deviceId ?? null,
      ip: getClientIp(request),
    };
    const { computeLimitPolicies: policy } = await getRuntimeConfig();
    const previewId = randomUUID();
    const admission = await reserveComputeAdmission({
      policy,
      action: 'tts_playback',
      // Deliberately not a `tts-session:` key: a preview admission must never
      // be found by the worker's per-session synthesis broker.
      requestKey: `tts-preview:${previewId}`,
      subject,
    });
    if (!admission.allowed || !admission.admissionId) return rateLimited(admission.retryAfterMs);

    let state: 'finished' | 'cancelled' = 'cancelled';
    try {
      await activateComputeAdmission({
        admissionId: admission.admissionId,
        leaseSeconds: PREVIEW_ADMISSION_LEASE_SECONDS,
      });
      const usage = await consumeComputeUsage({
        policy,
        action: 'tts_synthesis',
        metric: 'characters',
        units: parsed.text.length,
        eventKey: `tts_preview:v1:${previewId}`,
        subject,
        admissionId: admission.admissionId,
      });
      if (!usage.allowed) return rateLimited(usage.retryAfterMs);

      const result = await new ComputeWorkerClient().synthesizeTtsVoicePreview(parsed, {
        signal: request.signal,
      });
      if (!result.ok) {
        logger.warn({
          event: 'tts.voice_preview.worker_rejected',
          status: result.status,
          code: result.code,
        }, 'Worker rejected a voice preview');
        const status = result.status === 429 ? 429 : result.status === 400 ? 400 : 502;
        return NextResponse.json({
          error: 'Voice preview is unavailable right now.',
          code: result.code ?? 'VOICE_PREVIEW_FAILED',
          ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}),
        }, { status });
      }

      state = 'finished';
      const response = new NextResponse(result.audio, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(result.audio.byteLength),
          'Cache-Control': 'no-store, private',
        },
      });
      if (device?.didCreate) setDeviceIdCookie(response, device.deviceId);
      return response;
    } finally {
      await finishComputeAdmission({ admissionId: admission.admissionId, state }).catch(() => undefined);
    }
  } catch (error) {
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    return errorResponse(error, {
      logger,
      event: 'tts.voice_preview.failed',
      msg: 'Failed to synthesize voice preview',
      apiErrorMessage: 'Failed to synthesize voice preview',
      normalize: { code: 'TTS_VOICE_PREVIEW_FAILED', errorClass: 'unknown' },
    });
  }
}
