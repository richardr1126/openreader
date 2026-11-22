import type { FastifyReply, FastifyRequest } from 'fastify';
import { getUpstreamStatus } from '@openreader/tts/upstream-response';
import { ProviderCapacityWaitTimeoutError } from '../../../jobs/provider-capacity';
import { TtsCredentialBrokerClientError } from '../../../jobs/tts-credential-broker-error';
import { TtsPlaybackSegmentTimeoutError } from '../../../jobs/playback/segment-generation';
import {
  synthesizeTtsVoicePreview,
  TTS_SPEECH_LIMITS,
  TTS_VOICE_PREVIEW_LIMITS,
  TtsVoicePreviewTooLargeError,
  type TtsClipLimits,
} from '../../../jobs/playback/voice-preview';
import type { ComputeWorkerRouteContext } from '../../route-context';
import { apiErrorResponseSchema, jsonSchema, ttsSpeechRequestSchema, ttsVoicePreviewRequestSchema } from '../../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

type VoicePreviewErrorStatus = 429 | 500 | 502 | 503 | 504;

/** Maps a preview failure to a status and a stable code; upstream text never leaves the worker. */
export function classifyVoicePreviewError(error: unknown, what = 'Voice preview'): {
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
    return { status: 504, code: error.code, error: `${what} timed out` };
  }
  if (error instanceof TtsVoicePreviewTooLargeError) {
    return { status: 502, code: error.code, error: `${what} audio was too large` };
  }
  const upstreamStatus = getUpstreamStatus(error);
  if (upstreamStatus === 429) {
    return { status: 429, code: 'UPSTREAM_RATE_LIMIT', error: `TTS provider rate limited the ${what.toLowerCase()}` };
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return { status: 502, code: 'UPSTREAM_AUTH', error: 'TTS provider rejected the API key' };
  }
  if (upstreamStatus === 402) {
    return { status: 502, code: 'UPSTREAM_CREDIT', error: 'TTS provider account has no remaining credit' };
  }
  if (upstreamStatus !== undefined) {
    return { status: 502, code: 'UPSTREAM_ERROR', error: `TTS provider rejected the ${what.toLowerCase()}` };
  }
  return { status: 500, code: 'PREVIEW_FAILED', error: `${what} failed` };
}

type ClipRoute = {
  schema: typeof ttsVoicePreviewRequestSchema | typeof ttsSpeechRequestSchema;
  limits: TtsClipLimits;
  /** Names the clip in errors, e.g. "Voice preview". */
  what: string;
  /** Prefixes log events, e.g. "tts.voice_preview". */
  event: string;
};

/** The route options and handler for a one-off MP3 clip. */
function clipRoute(context: ComputeWorkerRouteContext, route: ClipRoute) {
  const { app, ttsVoicePreview } = context;

  const options = {
    schema: {
      body: jsonSchema(route.schema),
      response: {
        200: { type: 'string', format: 'binary', description: `MP3 ${route.what.toLowerCase()}` },
        400: errorResponseSchema,
        429: errorResponseSchema,
        500: errorResponseSchema,
        502: errorResponseSchema,
        503: errorResponseSchema,
        504: errorResponseSchema,
      },
    },
  };
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = route.schema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body' };
    }

    // The app cancels a superseded clip by dropping its request; stop the
    // provider call with it instead of finishing audio nobody will hear.
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) controller.abort(new Error(`${route.what} request closed`));
    });

    const startedAt = Date.now();
    try {
      const audio = await synthesizeTtsVoicePreview(parsed.data, ttsVoicePreview, controller.signal, route.limits);
      app.log.info({
        characters: parsed.data.text.length,
        bytes: audio.byteLength,
        durationMs: Date.now() - startedAt,
      }, `${route.event}.completed`);
      reply.header('Cache-Control', 'no-store');
      reply.type('audio/mpeg');
      return reply.send(audio);
    } catch (error) {
      if (controller.signal.aborted) return reply;
      const classified = classifyVoicePreviewError(error, route.what);
      app.log.warn({
        code: classified.code,
        characters: parsed.data.text.length,
        durationMs: Date.now() - startedAt,
      }, `${route.event}.failed`);
      reply.code(classified.status);
      return { error: classified.error, code: classified.code };
    }
  };
  return [options, handler] as const;
}

export function registerVoicePreviewRoutes(context: ComputeWorkerRouteContext): void {
  const { app } = context;
  app.post('/v1/tts-playback/voice-previews', ...clipRoute(context, {
    schema: ttsVoicePreviewRequestSchema,
    limits: TTS_VOICE_PREVIEW_LIMITS,
    what: 'Voice preview',
    event: 'tts.voice_preview',
  }));
  // API speech: a short text spoken once for an app, kept nowhere.
  app.post('/v1/tts/speech', ...clipRoute(context, {
    schema: ttsSpeechRequestSchema,
    limits: TTS_SPEECH_LIMITS,
    what: 'Speech',
    event: 'tts.speech',
  }));
}
