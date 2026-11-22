import { eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { userPreferences } from '@openreader/database/schema';
import { apiErrorResponse } from '@/lib/server/api/responses';
import type { TtsSpeechRequest } from '@/lib/server/compute-worker/protocol';
import { storedRecord } from '@/lib/server/reader/bootstrap';
import { resolveSpeechSettings } from '@/lib/server/reader/playback';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { API_SPEECH_MAX_TEXT_CHARS } from '@/lib/shared/tts-voice-preview';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';


export type SpeechBody = {
  text: string;
  provider?: string;
  model?: string;
  voice?: string;
  modelSpeed?: number;
};

const FIELDS = new Set(['text', 'provider', 'model', 'voice', 'modelSpeed']);

function optionalId(value: unknown, max: number): string | undefined | false {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : false;
}

/** Validates a speech request body, or returns the 400 to send. */
export function parseSpeechBody(value: unknown): SpeechBody | Response {
  const invalid = (message: string) => apiErrorResponse(400, 'REQUEST_INVALID', message);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('The body must be a JSON object.');
  const rec = value as Record<string, unknown>;
  const unknown = Object.keys(rec).find((key) => !FIELDS.has(key));
  if (unknown) return invalid(`Unknown field ${unknown}.`);
  // Counted in UTF-16 units, as the worker and usage limits count it; the OpenAPI schema says so.
  const text = typeof rec.text === 'string' ? rec.text.trim() : '';
  if (!text || text.length > API_SPEECH_MAX_TEXT_CHARS) {
    return invalid(`text must be 1 to ${API_SPEECH_MAX_TEXT_CHARS} characters.`);
  }
  const provider = optionalId(rec.provider, 200);
  if (provider === false) return invalid('provider must be a speech provider ID.');
  // The worker takes model IDs up to 256 characters; reject longer ones before usage is charged.
  const model = optionalId(rec.model, 256);
  if (model === false) return invalid('model must be a speech model ID.');
  const voice = optionalId(rec.voice, 512);
  if (voice === false) return invalid('voice must be a voice ID.');
  const { modelSpeed } = rec;
  if (modelSpeed !== undefined && (typeof modelSpeed !== 'number' || !Number.isFinite(modelSpeed) || modelSpeed < 0.5 || modelSpeed > 3)) {
    return invalid('modelSpeed must be a number from 0.5 to 3.');
  }
  return {
    text,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
    ...(typeof modelSpeed === 'number' ? { modelSpeed: Math.round(modelSpeed * 100) / 100 } : {}),
  };
}

/**
 * The worker settings for a user's speech: their saved provider, model, voice
 * and speed, as the reader would use them, with the body's choices on top.
 */
export async function resolveApiSpeechSettings(
  userId: string,
  body: SpeechBody,
): Promise<TtsSpeechRequest['settings'] | Response> {
  const rows = await db.select({ dataJson: userPreferences.dataJson }).from(userPreferences)
    .where(eq(userPreferences.userId, userId)).limit(1);
  const resolved = await resolveSpeechSettings(
    userId,
    mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {}),
    storedRecord(rows[0]?.dataJson),
    null,
    { provider: body.provider, model: body.model, voice: body.voice, modelSpeed: body.modelSpeed, checkVoice: true },
  );
  if ('error' in resolved && resolved.invalid) return apiErrorResponse(400, 'REQUEST_INVALID', resolved.error);
  if ('error' in resolved) return apiErrorResponse(503, 'PROVIDER_UNAVAILABLE', resolved.error, { retryAfterMs: 5_000 });
  const { settings } = resolved;
  if (!settings.voice) {
    return apiErrorResponse(503, 'PROVIDER_UNAVAILABLE', 'No speech provider is set up on this instance.', { retryAfterMs: 5_000 });
  }
  // The worker takes exactly these fields; reader-only ones (such as how to
  // speak citations) don't apply to one clip.
  return {
    providerRef: settings.providerRef,
    providerType: settings.providerType,
    ttsModel: settings.ttsModel,
    voice: settings.voice,
    nativeSpeed: settings.nativeSpeed,
    ...(settings.ttsInstructions ? { ttsInstructions: settings.ttsInstructions } : {}),
    ...(settings.ttsModelOptions ? { ttsModelOptions: settings.ttsModelOptions } : {}),
    ...(settings.language && settings.language !== 'auto' ? { language: settings.language } : {}),
    ...(settings.voiceCustomization ? { voiceCustomization: settings.voiceCustomization } : {}),
  };
}
