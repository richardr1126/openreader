import type { generateTTSBuffer } from '@openreader/tts/generate';
import type { TTSSegmentSettings } from '@openreader/tts/types';
import type { resolveTtsCredentialsFromBroker } from '../tts-credential-broker';
import { resolveEffectiveTtsSettings } from './provider-settings';
import { resolveClonedVoice } from './cloned-voice';
import { withAbortableTimeout } from './segment-generation';

/** A preview speaks one short sentence; longer text is a caller bug. */
export const TTS_VOICE_PREVIEW_MAX_TEXT_CHARS = 300;
/** Bounds worker memory for one preview; a sentence of MP3 is far smaller. */
export const TTS_VOICE_PREVIEW_MAX_AUDIO_BYTES = 2 * 1024 * 1024;
/** Upper bound on one preview's synthesis, below the playback segment timeout. */
export const TTS_VOICE_PREVIEW_TIMEOUT_MS = 30_000;

/** Bounds on one in-memory clip: its text, its audio and its synthesis time. */
export interface TtsClipLimits {
  maxTextChars: number;
  maxAudioBytes: number;
  timeoutMs: number;
}

export const TTS_VOICE_PREVIEW_LIMITS: TtsClipLimits = {
  maxTextChars: TTS_VOICE_PREVIEW_MAX_TEXT_CHARS,
  maxAudioBytes: TTS_VOICE_PREVIEW_MAX_AUDIO_BYTES,
  timeoutMs: TTS_VOICE_PREVIEW_TIMEOUT_MS,
};

/** API speech speaks a paragraph or two (a chat reply, a podcast line), never a document. */
export const TTS_SPEECH_MAX_TEXT_CHARS = 2000;
export const TTS_SPEECH_LIMITS: TtsClipLimits = {
  maxTextChars: TTS_SPEECH_MAX_TEXT_CHARS,
  // About ten minutes of 128 kbps MP3, far more than 2000 characters take to say.
  maxAudioBytes: 10 * 1024 * 1024,
  timeoutMs: 90_000,
};

export class TtsVoicePreviewTooLargeError extends Error {
  readonly code = 'PREVIEW_AUDIO_TOO_LARGE';

  constructor() {
    super('Speech audio exceeded its size limit');
    this.name = 'TtsVoicePreviewTooLargeError';
  }
}

export interface TtsVoicePreviewDeps {
  readObject?: (key: string) => Promise<Uint8Array>;
  s3Prefix?: string;
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
 * Synthesizes a short clip (a voice sample, or API speech) in memory and
 * returns it. A clip never touches a document's canonical timeline, segment
 * cache, or object storage: nothing is persisted, so it cannot be mistaken
 * for playback audio. Provider credentials come from the app's credential
 * broker and stay inside this call.
 */
export async function synthesizeTtsVoicePreview(
  input: { settings: TTSSegmentSettings; text: string; userId?: string },
  deps: TtsVoicePreviewDeps,
  signal?: AbortSignal,
  limits: TtsClipLimits = TTS_VOICE_PREVIEW_LIMITS,
): Promise<Buffer> {
  const text = input.text.trim();
  if (!text || text.length > limits.maxTextChars) {
    throw new Error('Speech text is empty or too long');
  }
  const creds = await deps.resolveCredentials(input.settings.providerRef, signal ? { signal } : {});
  const settings = resolveEffectiveTtsSettings(input.settings, creds);
  const resolvedVoice = await resolveClonedVoice({ settings, userId: input.userId, prefix: deps.s3Prefix ?? '',
    readObject: deps.readObject ?? (async () => { throw new Error('Cloned voice storage is unavailable'); }) });
  const release = deps.acquireProviderCapacity
    ? await deps.acquireProviderCapacity({ providerRef: creds.providerRef, characters: text.length, signal })
    : async () => undefined;
  const timeoutMs = Math.min(deps.synthesisTimeoutMs, limits.timeoutMs);
  try {
    const audio = await withAbortableTimeout(
      (synthesisSignal) => deps.synthesize({
        text,
        ...resolvedVoice,
        speed: settings.nativeSpeed,
        format: 'mp3',
        model: settings.ttsModel,
        instructions: settings.ttsInstructions,
        modelOptions: settings.ttsModelOptions,
        language: settings.language,
        provider: creds.providerType,
        ...(settings.voiceCustomization ? { voiceCustomization: settings.voiceCustomization } : {}),
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl ?? undefined,
      }, synthesisSignal, { ttsUpstreamTimeoutMs: timeoutMs }),
      timeoutMs,
      'tts voice preview synthesis',
      signal,
    );
    if (audio.byteLength > limits.maxAudioBytes) throw new TtsVoicePreviewTooLargeError();
    return audio;
  } finally {
    await release().catch(() => undefined);
  }
}
