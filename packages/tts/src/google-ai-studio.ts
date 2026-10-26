import { GOOGLE_AI_STUDIO_MODELS } from './provider-catalog';

export const GOOGLE_AI_STUDIO_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Instructions stay outside the verbatim transcript so they cannot be narrated. */
export function googleSpeechBody(input: { model: string; text: string; voice: string; instructions?: string }) {
  if (!GOOGLE_AI_STUDIO_MODELS.some(({ id }) => id === input.model)) {
    throw Object.assign(new Error('Choose a supported Google AI Studio speech model.'), { status: 422 });
  }
  if (!input.voice || input.voice === 'default') {
    throw Object.assign(new Error('Choose a Google AI Studio voice.'), { status: 422 });
  }
  return {
    model: input.model,
    input: [{ type: 'user_input', content: [{ type: 'text', text: input.text,
      ...(input.instructions ? { annotations: [{ type: 'speech_metadata', style: input.instructions }] } : {}),
    }] }],
    response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24000 },
    generation_config: { speech_config: [{ voice: input.voice }] },
    store: false,
  };
}

/** REST exposes steps; output_audio is an SDK convenience, not a wire field. */
export function googleSpeechAudio(value: unknown): Buffer {
  const body = value as { status?: string; steps?: { type?: string; content?: { type?: string; mime_type?: string; data?: string }[] }[] } | null;
  const audio = Array.isArray(body?.steps) ? body.steps.filter((step) => step.type === 'model_output')
    .flatMap((step) => Array.isArray(step.content) ? step.content : []).filter((part) => part.type === 'audio').at(-1) : undefined;
  if (body?.status !== 'completed' || audio?.mime_type !== 'audio/wav' || typeof audio.data !== 'string'
    || !audio.data.length || audio.data.length > 44 * 1024 * 1024
    || audio.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) {
    throw new Error('Google AI Studio returned no usable WAV audio');
  }
  const buffer = Buffer.from(audio.data, 'base64');
  if (buffer.length < 44 || buffer.length > 32 * 1024 * 1024
    || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Google AI Studio returned invalid WAV audio');
  }
  return buffer;
}
