import { getUpstreamStatus } from '@openreader/tts/upstream-response';
import { ProviderCapacityWaitTimeoutError } from '../../../jobs/provider-capacity';
import { TtsCredentialBrokerClientError } from '../../../jobs/tts-credential-broker-error';
import { TtsPlaybackSegmentTimeoutError } from '../../../jobs/playback/segment-generation';
import {
  synthesizeTtsVoicePreview,
  TtsVoicePreviewTooLargeError,
} from '../../../jobs/playback/voice-preview';
import type { ComputeWorkerRouteContext } from '../../route-context';
import { apiErrorResponseSchema, jsonSchema, ttsVoicePreviewRequestSchema } from '../../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

type VoicePreviewErrorStatus = 429 | 500 | 502 | 503 | 504;

/** Maps a preview failure to a status and a stable code; upstream text never leaves the worker. */
export function classifyVoicePreviewError(error: unknown): {
  status: VoicePreviewErrorStatus;
  code: string;
  error: string;
} {
  if (error instanceof TtsCredentialBrokerClientError) {
    return { status: 503, code: error.code, error: 'TTS provider is unavailable' };
  }
  if (error instanceof ProviderCapacityWaitTimeoutError) {
    return { status: 429, code: error.code, error: 'TTS provider is busy' };
  }
  if (error instanceof TtsPlaybackSegmentTimeoutError) {
    return { status: 504, code: error.code, error: 'Voice preview timed out' };
  }
  if (error instanceof TtsVoicePreviewTooLargeError) {
    return { status: 502, code: error.code, error: 'Voice preview audio was too large' };
  }
  const upstreamStatus = getUpstreamStatus(error);
  if (upstreamStatus === 429) {
    return { status: 429, code: 'UPSTREAM_RATE_LIMIT', error: 'TTS provider rate limited the preview' };
  }
  if (upstreamStatus !== undefined) {
    return { status: 502, code: 'UPSTREAM_ERROR', error: 'TTS provider rejected the preview' };
  }
  return { status: 500, code: 'PREVIEW_FAILED', error: 'Voice preview failed' };
}

export function registerVoicePreviewRoutes(context: ComputeWorkerRouteContext): void {
  const { app, ttsVoicePreview } = context;

  app.post('/v1/tts-playback/voice-previews', {
    schema: {
      body: jsonSchema(ttsVoicePreviewRequestSchema),
      response: {
        200: { type: 'string', format: 'binary', description: 'MP3 voice preview' },
        400: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
        502: errorResponseSchema,
        503: errorResponseSchema,
        504: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = ttsVoicePreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body' };
    }

    // The app cancels a superseded preview by dropping its request; stop the
    // provider call with it instead of finishing audio nobody will hear.
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) controller.abort(new Error('Voice preview request closed'));
    });

    const startedAt = Date.now();
    try {
      const audio = await synthesizeTtsVoicePreview(parsed.data, ttsVoicePreview, controller.signal);
      app.log.info({
        characters: parsed.data.text.length,
        bytes: audio.byteLength,
        durationMs: Date.now() - startedAt,
      }, 'tts.voice_preview.completed');
      reply.header('Cache-Control', 'no-store');
      reply.type('audio/mpeg');
      return reply.send(audio);
    } catch (error) {
      if (controller.signal.aborted) return reply;
      const classified = classifyVoicePreviewError(error);
      app.log.warn({
        code: classified.code,
        characters: parsed.data.text.length,
        durationMs: Date.now() - startedAt,
      }, 'tts.voice_preview.failed');
      reply.code(classified.status);
      return { error: classified.error, code: classified.code };
    }
  });
}
