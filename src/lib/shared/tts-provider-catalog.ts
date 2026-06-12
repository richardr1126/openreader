import { isKokoroModel } from '@/lib/shared/kokoro';

export type TtsProviderId = 'custom-openai' | 'replicate' | 'deepinfra' | 'openai' | 'speech-sdk';
export type TtsProviderType = TtsProviderId | 'unknown';
export type TtsVoiceSource = 'static' | 'deepinfra-api' | 'custom-openai-api' | 'replicate-api';
export type ReplicateVoiceInputKey = 'voice' | 'voice_id' | 'speaker';

export interface SharedProviderTypeResolverEntry {
  slug: string;
  providerType: TtsProviderId;
  defaultModel?: string | null;
  defaultInstructions?: string | null;
}

export interface TtsModelDefinition {
  id: string;
  name: string;
}

export interface TtsProviderDefinition {
  id: TtsProviderId;
  name: string;
  supportsCustomModel: boolean;
  models: (context?: ResolveProviderModelsContext) => TtsModelDefinition[];
}

export interface ResolveProviderModelsContext {
  apiKey?: string;
}

export interface ResolveVoicesOptions {
  provider: TtsProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

const OPENAI_MODELS: TtsModelDefinition[] = [
  { id: 'tts-1', name: 'TTS-1' },
  { id: 'tts-1-hd', name: 'TTS-1 HD' },
  { id: 'gpt-4o-mini-tts', name: 'GPT-4o Mini TTS' },
];

const CUSTOM_OPENAI_MODELS: TtsModelDefinition[] = [
  { id: 'kokoro', name: 'Kokoro' },
  { id: 'kitten-tts', name: 'KittenTTS' },
  { id: 'orpheus', name: 'Orpheus' },
  { id: 'custom', name: 'Other' },
];

const DEEPINFRA_MODELS_FULL: TtsModelDefinition[] = [
  { id: 'hexgrad/Kokoro-82M', name: 'hexgrad/Kokoro-82M' },
  { id: 'canopylabs/orpheus-3b-0.1-ft', name: 'canopylabs/orpheus-3b-0.1-ft' },
  { id: 'sesame/csm-1b', name: 'sesame/csm-1b' },
  { id: 'ResembleAI/chatterbox', name: 'ResembleAI/chatterbox' },
  { id: 'Zyphra/Zonos-v0.1-hybrid', name: 'Zyphra/Zonos-v0.1-hybrid' },
  { id: 'Zyphra/Zonos-v0.1-transformer', name: 'Zyphra/Zonos-v0.1-transformer' },
  { id: 'custom', name: 'Other' },
];

export const REPLICATE_KOKORO_82M_VERSIONED_MODEL =
  'alphanumericuser/kokoro-82m:89b6fa84e4fa2dd6bd3a96be3e1f12827a3516c9fda8fddbac7a0be131c9a6f5' as const;

const REPLICATE_MODELS: TtsModelDefinition[] = [
  {
    id: REPLICATE_KOKORO_82M_VERSIONED_MODEL,
    name: 'alphanumericuser/kokoro-82m',
  },
  { id: 'google/gemini-3.1-flash-tts', name: 'google/gemini-3.1-flash-tts' },
  { id: 'minimax/speech-2.8-turbo', name: 'minimax/speech-2.8-turbo' },
  { id: 'qwen/qwen3-tts', name: 'qwen/qwen3-tts' },
  { id: 'inworld/tts-1.5-mini', name: 'inworld/tts-1.5-mini' },
  { id: 'custom', name: 'Other' },
];

const SPEECH_SDK_MODELS: TtsModelDefinition[] = [
  { id: 'openai/gpt-4o-mini-tts', name: 'openai/gpt-4o-mini-tts' },
  { id: 'elevenlabs/eleven_multilingual_v2', name: 'elevenlabs/eleven_multilingual_v2' },
  { id: 'cartesia/sonic-3.5', name: 'cartesia/sonic-3.5' },
  { id: 'deepgram/aura-2', name: 'deepgram/aura-2' },
  { id: 'google/gemini-2.5-flash-preview-tts', name: 'google/gemini-2.5-flash-preview-tts' },
  { id: 'inworld/inworld-tts-1.5-max', name: 'inworld/inworld-tts-1.5-max' },
  { id: 'custom', name: 'Other' },
];
const DEEPINFRA_API_VOICE_MODELS = new Set([
  'ResembleAI/chatterbox',
  'Zyphra/Zonos-v0.1-hybrid',
  'Zyphra/Zonos-v0.1-transformer',
]);

const DEFAULT_MODELS: TtsModelDefinition[] = [{ id: 'tts-1', name: 'TTS-1' }];

export const OPENAI_DEFAULT_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
export const GPT4O_MINI_DEFAULT_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'] as const;
export const CUSTOM_OPENAI_DEFAULT_VOICES = ['af_sarah', 'af_bella', 'af_nicole', 'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis'] as const;
export const KOKORO_DEFAULT_VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova',
  'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis', 'ef_dora', 'em_alex', 'em_santa', 'ff_siwis',
  'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune',
  'jf_nezumi', 'jf_tebukuro', 'jm_kumo', 'pf_dora', 'pm_alex', 'pm_santa', 'zf_xiaobei', 'zf_xiaoni',
  'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
] as const;
export const ORPHEUS_DEFAULT_VOICES = ['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac'] as const;
export const SESAME_DEFAULT_VOICES = ['conversational_a', 'conversational_b', 'read_speech_a', 'read_speech_b', 'read_speech_c', 'read_speech_d', 'none'] as const;

// Replicate model voices
export const GEMINI_FLASH_TTS_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algenib',
  'Despina', 'Erinome', 'Laomedeia', 'Achernar', 'Algieba', 'Schedar',
  'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix',
  'Sadachbia', 'Sadaltager', 'Sulafat', 'Alnilam', 'Rasalgethi',
] as const;
export const MINIMAX_SPEECH_VOICES = [
  'Deep_Voice_Man', 'Imposing_Manner', 'Elegant_Man', 'Casual_Guy',
  'Friendly_Person', 'Decent_Boy', 'Lively_Girl', 'Exuberant_Girl',
  'Inspirational_girl', 'Young_Knight', 'Abbess', 'Wise_Woman',
] as const;
export const QWEN3_TTS_VOICES = ['Aiden', 'Dylan'] as const;
export const INWORLD_TTS_VOICES = ['Ashley', 'Dennis', 'Alex', 'Darlene'] as const;

// Speech SDK direct-provider voices. ElevenLabs and Cartesia identify voices by
// opaque IDs; the listed ones are stable, publicly shared library voices.
export const ELEVENLABS_DEFAULT_VOICES = [
  'JBFqnCBsd6RMkjVDRZzb', 'IKne3meq5aSn9XLyUdCD', 'XB0fDUnXU5powFXDhCwa',
  'Xb7hH8MSUJpSbSDYk0k2', 'iP95p4xoKVk53GoZ742B', 'nPczCjzI2devNBz1zQrb',
  'onwK4e9ZLuTAKqWW03F9', 'pFZP5JQG7iQjIQuC4Bku', 'pqHfZKP75CvOlQylNhV4',
] as const;
export const CARTESIA_DEFAULT_VOICES = [
  'a0e99841-438c-4a64-b679-ae501e7d6091', '156fb8d2-335b-4950-9cb3-a2d33f0c0c2a',
  '694f9389-aac1-45b6-b726-9d9369183238', '87748186-23bb-4571-8b8b-a73da9bf9c4f',
  'ee7ea9f8-c0c1-498c-9f62-dc2da49a6f98', '248be419-c632-4f23-adf1-5324ed7dbf1d',
] as const;
export const HUME_DEFAULT_VOICES = ['KORA', 'STELLA', 'DACHER'] as const;
export const DEEPGRAM_AURA2_DEFAULT_VOICES = [
  'thalia-en', 'andromeda-en', 'helena-en', 'apollo-en', 'arcas-en',
  'aries-en', 'asteria-en', 'athena-en', 'atlas-en', 'aurora-en',
] as const;
export const INWORLD_DIRECT_DEFAULT_VOICES = ['Ashley', 'Dominus', 'Edward', 'Hades', 'Priya'] as const;
const SPEECH_SDK_DEFAULT_VOICES_BY_PREFIX: Record<string, readonly string[]> = {
  openai: GPT4O_MINI_DEFAULT_VOICES,
  elevenlabs: ELEVENLABS_DEFAULT_VOICES,
  cartesia: CARTESIA_DEFAULT_VOICES,
  hume: HUME_DEFAULT_VOICES,
  deepgram: DEEPGRAM_AURA2_DEFAULT_VOICES,
  google: GEMINI_FLASH_TTS_VOICES,
  inworld: INWORLD_DIRECT_DEFAULT_VOICES,
  minimax: MINIMAX_SPEECH_VOICES,
};

export function speechSdkProviderPrefix(model: string): string {
  const slashIndex = model.indexOf('/');
  return slashIndex === -1 ? model : model.slice(0, slashIndex);
}
const REPLICATE_DEFAULT_VOICES_BY_MODEL: Record<string, readonly string[]> = {
  [REPLICATE_KOKORO_82M_VERSIONED_MODEL]: KOKORO_DEFAULT_VOICES,
  'google/gemini-3.1-flash-tts': GEMINI_FLASH_TTS_VOICES,
  'minimax/speech-2.8-turbo': MINIMAX_SPEECH_VOICES,
  'qwen/qwen3-tts': QWEN3_TTS_VOICES,
  'inworld/tts-1.5-mini': INWORLD_TTS_VOICES,
};
const DEEPINFRA_DEFAULT_VOICES_BY_MODEL: Record<string, readonly string[]> = {
  'hexgrad/Kokoro-82M': KOKORO_DEFAULT_VOICES,
  'canopylabs/orpheus-3b-0.1-ft': ORPHEUS_DEFAULT_VOICES,
  'sesame/csm-1b': SESAME_DEFAULT_VOICES,
  'ResembleAI/chatterbox': ['None'],
  'Zyphra/Zonos-v0.1-hybrid': ['random'],
  'Zyphra/Zonos-v0.1-transformer': ['random'],
};

export const TTS_PROVIDER_DEFINITIONS: TtsProviderDefinition[] = [
  {
    id: 'custom-openai',
    name: 'Custom OpenAI-Like',
    supportsCustomModel: true,
    models: () => CUSTOM_OPENAI_MODELS,
  },
  {
    id: 'replicate',
    name: 'Replicate',
    supportsCustomModel: true,
    models: () => REPLICATE_MODELS,
  },
  {
    id: 'deepinfra',
    name: 'Deepinfra',
    supportsCustomModel: true,
    models: () => DEEPINFRA_MODELS_FULL,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    supportsCustomModel: false,
    models: () => OPENAI_MODELS,
  },
  {
    id: 'speech-sdk',
    name: 'Speech SDK',
    supportsCustomModel: true,
    models: () => SPEECH_SDK_MODELS,
  },
];

const BUILT_IN_PROVIDER_ID_SET: ReadonlySet<TtsProviderId> = new Set(
  TTS_PROVIDER_DEFINITIONS.map((definition) => definition.id),
);
const TTS_PROVIDER_TYPE_SET: ReadonlySet<TtsProviderType> = new Set([
  ...TTS_PROVIDER_DEFINITIONS.map((definition) => definition.id),
  'unknown',
]);

const MODELS_WITH_INSTRUCTIONS = new Set([
  'gpt-4o-mini-tts',
  'google/gemini-3.1-flash-tts',
  'qwen/qwen3-tts',
]);

const REPLICATE_MODELS_WITHOUT_NATIVE_SPEED = new Set([
  'google/gemini-3.1-flash-tts',
  'qwen/qwen3-tts',
]);

export function supportsTtsInstructions(model: string | null | undefined): boolean {
  return !!model && MODELS_WITH_INSTRUCTIONS.has(model);
}

export function isBuiltInTtsProviderId(value: string | null | undefined): value is TtsProviderId {
  return typeof value === 'string' && BUILT_IN_PROVIDER_ID_SET.has(value as TtsProviderId);
}

export function isTtsProviderType(value: unknown): value is TtsProviderType {
  return typeof value === 'string' && TTS_PROVIDER_TYPE_SET.has(value as TtsProviderType);
}

export function resolveProviderType(
  providerRef: string | null | undefined,
  sharedProviders: readonly SharedProviderTypeResolverEntry[] = [],
): TtsProviderType {
  if (isBuiltInTtsProviderId(providerRef)) {
    return providerRef;
  }

  if (!providerRef) {
    return 'unknown';
  }

  const shared = sharedProviders.find((entry) => entry.slug === providerRef);
  return shared ? shared.providerType : 'unknown';
}

export function supportsNativeModelSpeed(provider: TtsProviderId, model: string | null | undefined): boolean {
  if (!model) {
    return true;
  }

  if (provider === 'replicate') {
    return !REPLICATE_MODELS_WITHOUT_NATIVE_SPEED.has(model);
  }

  // Speed support varies per underlying provider; play back at the requested
  // rate client-side so cached audio stays reusable across speed changes.
  if (provider === 'speech-sdk') {
    return false;
  }

  return true;
}

export function getProviderDefinition(provider: string | null | undefined): TtsProviderDefinition | undefined {
  return isBuiltInTtsProviderId(provider)
    ? TTS_PROVIDER_DEFINITIONS.find((definition) => definition.id === provider)
    : undefined;
}

export function resolveProviderModels(provider: TtsProviderId, context?: ResolveProviderModelsContext): TtsModelDefinition[] {
  return getProviderDefinition(provider)?.models(context) ?? DEFAULT_MODELS;
}

export function providerSupportsCustomModel(provider: TtsProviderId): boolean {
  return getProviderDefinition(provider)?.supportsCustomModel ?? false;
}

export function getDefaultVoices(provider: TtsProviderId, model: string): string[] {
  if (provider === 'openai') {
    return supportsTtsInstructions(model) ? [...GPT4O_MINI_DEFAULT_VOICES] : [...OPENAI_DEFAULT_VOICES];
  }

  if (provider === 'custom-openai') {
    // Kokoro models get the kokoro voice set; any other OpenAI-compatible model
    // falls back to the canonical OpenAI six, which such servers generally accept.
    return isKokoroModel(model) ? [...KOKORO_DEFAULT_VOICES] : [...OPENAI_DEFAULT_VOICES];
  }

  if (provider === 'replicate') {
    return REPLICATE_DEFAULT_VOICES_BY_MODEL[model] ? [...REPLICATE_DEFAULT_VOICES_BY_MODEL[model]] : ['default'];
  }

  if (provider === 'deepinfra') {
    return DEEPINFRA_DEFAULT_VOICES_BY_MODEL[model]
      ? [...DEEPINFRA_DEFAULT_VOICES_BY_MODEL[model]]
      : [...CUSTOM_OPENAI_DEFAULT_VOICES];
  }

  if (provider === 'speech-sdk') {
    const prefixVoices = SPEECH_SDK_DEFAULT_VOICES_BY_PREFIX[speechSdkProviderPrefix(model)];
    return prefixVoices ? [...prefixVoices] : ['default'];
  }

  return [...OPENAI_DEFAULT_VOICES];
}

function parseReplicateModelIdentifier(model: string): {
  owner: string;
  name: string;
  version?: string;
} | null {
  const [ref, version] = model.split(':', 2);
  const segments = ref.split('/');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return null;
  }

  const parsed = {
    owner: segments[0],
    name: segments[1],
  };

  return version
    ? { ...parsed, version }
    : parsed;
}

export function resolveVoiceSource(provider: TtsProviderId, model: string): TtsVoiceSource {
  if (provider === 'deepinfra' && DEEPINFRA_API_VOICE_MODELS.has(model)) {
    return 'deepinfra-api';
  }

  if (provider === 'replicate' && parseReplicateModelIdentifier(model) !== null) {
    return 'replicate-api';
  }

  if (provider === 'custom-openai') {
    return 'custom-openai-api';
  }

  return 'static';
}
