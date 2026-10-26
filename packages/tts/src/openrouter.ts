/** Public speech metadata and request policy. No credentials belong here. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'fish-audio/s2.1-pro-free:free';
export const OPENROUTER_OPTIONS_LIMIT = 16_384;

export interface OpenRouterSpeechModel {
  id: string;
  name: string;
  supportedVoices: string[] | null;
}

export function parseOpenRouterModels(body: unknown): OpenRouterSpeechModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('OpenRouter returned an invalid speech catalog');
  return data.flatMap((entry) => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string'
      || !entry.architecture?.output_modalities?.includes('speech')) return [];
    return [{ id: entry.id, name: entry.name, supportedVoices: Array.isArray(entry.supported_voices)
      ? entry.supported_voices.filter((voice: unknown): voice is string => typeof voice === 'string') : null }];
  });
}

export function openRouterCapabilities(model: string) {
  return {
    instructions: /^(openai\/gpt-4o-mini-tts|google\/gemini-.*tts|fish-audio\/)/.test(model),
    nativeSpeed: /^(openai\/|fish-audio\/|bytedance-seed\/seed-audio-1-0$)/.test(model),
    format: /^(google\/|heygen\/)/.test(model) ? 'pcm' as const : 'mp3' as const,
    // OpenRouter's raw PCM speech contract is signed 16-bit, 24 kHz mono.
    pcmSampleRate: 24_000,
    automaticVoice: model === 'bytedance-seed/seed-audio-1-0' || model.startsWith('fish-audio/'),
    providerSlug: model.startsWith('google/') ? 'google-ai-studio'
      : model.startsWith('bytedance-seed/') ? 'seed'
      : model.split('/')[0],
  };
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface OpenRouterModelOptions {
  model: string;
  provider?: { options: Record<string, Record<string, JsonValue>>; zdr?: boolean; data_collection?: 'allow' | 'deny' };
  input_references?: Array<{ type: 'input_audio'; input_audio: { url: string } | { data: string } } | { type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown, depth = 0): JsonValue {
  if (depth > 8) throw new Error('Model options are nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
  if (!record(value)) throw new Error('Model options must contain JSON values');
  return Object.fromEntries(Object.keys(value).sort().map(key => {
    if (/^(?:__proto__|prototype|constructor|api[_-]?key|authorization|password|secret|credentials?|access[_-]?token)$/i.test(key)) {
      throw new Error('Credentials cannot be stored in model options');
    }
    return [key, canonical(value[key], depth + 1)];
  }));
}

/** Bind options to their model; an old model's settings never go on wire. */
export function normalizeOpenRouterOptions(value: string | undefined, model: string): string {
  if (!value?.trim()) return '';
  if (value.length > OPENROUTER_OPTIONS_LIMIT) throw new Error('Model options exceed 16 KB');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Model options must be valid JSON'); }
  if (!record(parsed)) throw new Error('Model options must be a JSON object');
  if (parsed.model !== undefined && parsed.model !== model) return '';
  if (Object.keys(parsed).some(key => !['model', 'provider', 'input_references'].includes(key))) {
    throw new Error('Use provider or input_references in model options');
  }
  if (parsed.provider !== undefined) {
    const p = parsed.provider;
    if (!record(p) || Object.keys(p).some(key => !['options', 'zdr', 'data_collection'].includes(key))
      || (p.zdr !== undefined && typeof p.zdr !== 'boolean')
      || (p.data_collection !== undefined && !['allow', 'deny'].includes(String(p.data_collection)))
      || (p.options !== undefined && (!record(p.options) || Object.values(p.options).some(v => !record(v))))) {
      throw new Error('Use provider.options keyed by provider slug and valid data policy values');
    }
  }
  if (parsed.input_references !== undefined) {
    if (!Array.isArray(parsed.input_references) || parsed.input_references.length > 7) throw new Error('Invalid reference list');
    let audio = 0, images = 0;
    for (const part of parsed.input_references) {
      if (!record(part)) throw new Error('Invalid reference');
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length <= 10_000) continue;
      const key = part.type === 'input_audio' ? 'input_audio' : part.type === 'image_url' ? 'image_url' : '';
      const reference = part[key];
      if (!key || !record(reference) || typeof reference.url !== 'string' || reference.url.length > 2048) throw new Error('Use a public HTTPS URL for each reference');
      const url = new URL(reference.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a public HTTPS URL for each reference');
      if (key === 'input_audio') audio += 1; else images += 1;
    }
    if (audio > 3 || images > 1) throw new Error('Use up to three audio references and one image');
  }
  const { model: _model, ...options } = parsed;
  return Object.keys(options).length ? JSON.stringify(canonical({ ...options, model })) : '';
}

/** A user's own options win; the provider's apply only to the model they were written for. */
export function resolveEffectiveOpenRouterOptions(
  model: string,
  requestOptions: string | null | undefined,
  sharedDefaultOptions: string | null | undefined,
): string {
  return normalizeOpenRouterOptions(requestOptions ?? undefined, model)
    || normalizeOpenRouterOptions(sharedDefaultOptions ?? undefined, model);
}

export function openRouterRequestOptions(value: string | undefined, model: string): Omit<OpenRouterModelOptions, 'model'> {
  const normalized = normalizeOpenRouterOptions(value, model);
  if (!normalized) return {};
  const { model: _model, ...options } = JSON.parse(normalized) as OpenRouterModelOptions;
  return options;
}

/** Split only at the provider boundary; preserve every source character. */
export function splitOpenRouterInput(text: string): string[] {
  const result: string[] = []; let rest = text;
  while (rest.length > 1000) {
    let cut = 1000;
    const space = rest.lastIndexOf(' ', cut);
    if (space >= 500) cut = space + 1;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    result.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest) result.push(rest);
  return result;
}

export interface OpenRouterSpeechEndpoint {
  supports_voice_cloning?: boolean;
  supports_multiple_audio_references?: boolean;
  supports_image_reference?: boolean;
}

export async function validateOpenRouterReferences(model: string, options: Omit<OpenRouterModelOptions, 'model'>, signal: AbortSignal): Promise<void> {
  const refs = options.input_references;
  if (!refs?.length) return;
  const audio = refs.filter(part => part.type === 'input_audio').length;
  const image = refs.some(part => part.type === 'image_url');
  if (!audio && !image) throw new Error('A transcript needs an audio reference');
  if (model === 'bytedance-seed/seed-audio-1-0' && ((audio && image) || (options && !audio && !image))) throw new Error('Seed accepts audio references or an image, separately');
  if (model.startsWith('heygen/') && image && !audio) throw new Error('HeyGen needs audio with an image reference');
  const parts = model.split('/');
  if (parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid OpenRouter model ID');
  const url = `${OPENROUTER_BASE_URL}/models/${parts.map(encodeURIComponent).join('/')}/endpoints`;
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error' });
  if (!response.ok) throw new Error(`OpenRouter endpoint discovery returned HTTP ${response.status}`);
  const body = await readPublicMetadata(response);
  const endpoints = (JSON.parse(body) as { data?: { endpoints?: OpenRouterSpeechEndpoint[] } }).data?.endpoints ?? [];
  if (!endpoints.some(endpoint => (!audio || endpoint.supports_voice_cloning)
    && (audio < 2 || endpoint.supports_multiple_audio_references) && (!image || endpoint.supports_image_reference))) {
    throw new Error('The selected OpenRouter model has no endpoint supporting these voice references');
  }
}

async function readPublicMetadata(response: Response): Promise<string> {
  if (!response.body) throw new Error('OpenRouter returned empty metadata');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw new Error('OpenRouter metadata exceeded its size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const body = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

/** Bounded public metadata cache; credentials and execution config never enter it. */
let catalog: { expires: number; models: OpenRouterSpeechModel[] } | undefined;
export async function fetchOpenRouterModels(signal?: AbortSignal): Promise<OpenRouterSpeechModel[]> {
  if (catalog && catalog.expires > Date.now()) return catalog.models;
  const response = await fetch(`${OPENROUTER_BASE_URL}/models?output_modalities=speech`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`OpenRouter catalog returned HTTP ${response.status}`);
  const models = parseOpenRouterModels(JSON.parse(await readPublicMetadata(response)));
  catalog = { models, expires: Date.now() + 5 * 60_000 };
  return models;
}

export function pcmToWav(pcm: Uint8Array, sampleRate = 24_000): Uint8Array {
  if (!pcm.byteLength || pcm.byteLength % 2) throw new Error('OpenRouter returned invalid PCM audio');
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const label = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i); };
  label(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, pcm.byteLength, true); wav.set(pcm, 44);
  return wav;
}
