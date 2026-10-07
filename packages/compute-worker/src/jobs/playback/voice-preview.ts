import type { generateTTSBuffer } from '@openreader/tts/generate';
import type { TTSSegmentSettings } from '@openreader/tts/types';
import type { resolveTtsCredentialsFromBroker } from '../tts-credential-broker';
import { resolveEffectiveTtsSettings } from './provider-settings';
import { withAbortableTimeout } from './segment-generation';

/** A preview speaks one short sentence; longer text is a caller bug. */
export const TTS_VOICE_PREVIEW_MAX_TEXT_CHARS = 300;
/** Bounds worker memory for one preview; a sentence of MP3 is far smaller. */
export const TTS_VOICE_PREVIEW_MAX_AUDIO_BYTES = 2 * 1024 * 1024;
/** Upper bound on one preview's synthesis, below the playback segment timeout. */
export const TTS_VOICE_PREVIEW_TIMEOUT_MS = 30_000;

export class TtsVoicePreviewTooLargeError extends Error {
  readonly code = 'PREVIEW_AUDIO_TOO_LARGE';

  constructor() {
    super('Voice preview audio exceeded its size limit');
    this.name = 'TtsVoicePreviewTooLargeError';
  }
}

export interface TtsVoicePreviewDeps {
  resolveCredentials: typeof resolveTtsCredentialsFromBroker;
  synthesize: typeof generateTTSBuffer;
  /** The worker's shared provider limiter; previews wait for a slot like segments. */
  acquireProviderCapacity?: (input: {
    providerRef: string;
    characters: number;
    signal?: AbortSignal;
  }) => Promise<() => Promise<void>>;
  synthesisTimeoutMs: number;
}

/**
 * Synthesizes a short voice sample in memory and returns it. A preview never
 * touches the document's canonical timeline, segment cache, or object
 * storage: nothing is persisted, so it cannot be mistaken for playback audio.
 * Provider credentials come from the app's credential broker and stay inside
 * this call.
 */
export async function synthesizeTtsVoicePreview(
  input: { settings: TTSSegmentSettings; text: string },
  deps: TtsVoicePreviewDeps,
  signal?: AbortSignal,
): Promise<Buffer> {
  const text = input.text.trim();
  if (!text || text.length > TTS_VOICE_PREVIEW_MAX_TEXT_CHARS) {
    throw new Error('Voice preview text is empty or too long');
  }
  const creds = await deps.resolveCredentials(input.settings.providerRef, signal ? { signal } : {});
  const settings = resolveEffectiveTtsSettings(input.settings, creds);
  const release = deps.acquireProviderCapacity
    ? await deps.acquireProviderCapacity({ providerRef: creds.providerRef, characters: text.length, signal })
    : async () => undefined;
  const timeoutMs = Math.min(deps.synthesisTimeoutMs, TTS_VOICE_PREVIEW_TIMEOUT_MS);
  try {
    const audio = await withAbortableTimeout(
      (synthesisSignal) => deps.synthesize({
        text,
        voice: settings.voice,
        speed: settings.nativeSpeed,
        format: 'mp3',
        model: settings.ttsModel,
        instructions: settings.ttsInstructions,
        language: settings.language,
        provider: creds.providerType,
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl ?? undefined,
      }, synthesisSignal, { ttsUpstreamTimeoutMs: timeoutMs }),
      timeoutMs,
      'tts voice preview synthesis',
      signal,
    );
    if (audio.byteLength > TTS_VOICE_PREVIEW_MAX_AUDIO_BYTES) throw new TtsVoicePreviewTooLargeError();
    return audio;
  } finally {
    await release().catch(() => undefined);
  }
}
