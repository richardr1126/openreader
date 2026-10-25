import { getMaxVoicesForProvider, isKokoroModel } from './kokoro';
import {
  getDefaultVoices,
  isBuiltInTtsProviderId,
  providerSupportsCustomModel,
  resolveProviderType,
  resolveVoiceSource,
  supportsNativeModelSpeed,
  supportsTtsInstructions,
  KOKORO_LOCAL_MODEL,
  type SharedProviderTypeResolverEntry,
  type TtsProviderId,
  type TtsProviderType,
  type TtsVoiceSource,
} from './provider-catalog';

export interface ResolveTtsPolicyInput {
  providerRef: string | null | undefined;
  providerType?: TtsProviderType | null | undefined;
  model: string | null | undefined;
  sharedProviders?: readonly SharedProviderTypeResolverEntry[];
}

export interface ProviderDefaultResolverEntry extends SharedProviderTypeResolverEntry {
  defaultModel?: string | null;
  defaultInstructions?: string | null;
}

export interface TtsProviderModelPolicy {
  providerRef: string;
  providerType: TtsProviderType;
  isResolvedProviderType: boolean;
  model: string;
  isKokoroModel: boolean;
  maxVoices: number;
  supportsNativeModelSpeed: boolean;
  supportsInstructions: boolean;
  supportsCustomModel: boolean;
  defaultVoices: string[];
  voiceSource: TtsVoiceSource;
}

export interface ResolvedProviderDefaults {
  providerRef: string;
  providerType: TtsProviderType;
  defaultModel: string;
  defaultVoice: string;
  defaultInstructions: string;
}

export interface ResolveTtsModelForProviderInput {
  providerRef: string | null | undefined;
  providerType?: TtsProviderType | null | undefined;
  model: string | null | undefined;
  sharedProviders?: readonly ProviderDefaultResolverEntry[];
  fallbackProviderRef?: string | null | undefined;
  showAllProviderModels?: boolean;
}

export function defaultModelForProviderType(providerType: TtsProviderId): string {
  if (providerType === 'openai') return 'tts-1';
  if (providerType === 'deepinfra') return 'hexgrad/Kokoro-82M';
  if (providerType === 'replicate') return 'google/gemini-3.1-flash-tts';
  if (providerType === 'kokoro-local') return KOKORO_LOCAL_MODEL;
  return 'kokoro';
}

export function defaultBaseUrlForProviderType(providerType: TtsProviderId): string {
  if (providerType === 'openai') return 'https://api.openai.com/v1';
  if (providerType === 'deepinfra') return 'https://api.deepinfra.com/v1/openai';
  return '';
}

export function defaultVoiceForProviderType(providerType: TtsProviderId): string {
  if (providerType === 'replicate') return 'Zephyr';
  if (providerType === 'openai') return 'alloy';
  if (providerType === 'deepinfra') return 'af_bella';
  if (providerType === 'kokoro-local') return 'af_heart';
  return 'af_sarah';
}

export function resolveProviderDefaults(input: {
  providerRef: string | null | undefined;
  providerType?: TtsProviderType | null | undefined;
  sharedProviders?: readonly ProviderDefaultResolverEntry[];
  fallbackProviderRef?: string | null | undefined;
}): ResolvedProviderDefaults {
  const sharedProviders = input.sharedProviders ?? [];
  const rawProviderRef = typeof input.providerRef === 'string' ? input.providerRef.trim() : '';
  // The legacy 'default-openai' sentinel meant "use the default" only when no
  // real shared provider has that slug (the env-seeded provider does), matching
  // the server's preference sanitizer.
  const isStaleSentinel = rawProviderRef === 'default-openai'
    && !sharedProviders.some((entry) => entry.slug === rawProviderRef);
  const fallbackRef = typeof input.fallbackProviderRef === 'string' ? input.fallbackProviderRef.trim() : '';
  const providerRef = (isStaleSentinel && fallbackRef ? '' : rawProviderRef) || fallbackRef;
  const providerType = resolveEffectiveProviderType({
    providerRef,
    providerType: input.providerType,
    sharedProviders,
  });
  const shared = sharedProviders.find((entry) => entry.slug === providerRef);
  const sharedDefaultModel = typeof shared?.defaultModel === 'string'
    ? shared.defaultModel.trim()
    : '';
  const sharedDefaultInstructions = typeof shared?.defaultInstructions === 'string'
    ? shared.defaultInstructions
    : '';

  return {
    providerRef,
    providerType,
    defaultModel: sharedDefaultModel || (isBuiltInTtsProviderId(providerType) ? defaultModelForProviderType(providerType) : ''),
    defaultVoice: isBuiltInTtsProviderId(providerType) ? defaultVoiceForProviderType(providerType) : '',
    defaultInstructions: sharedDefaultInstructions,
  };
}

export function resolveEffectiveProviderType(input: {
  providerRef: string | null | undefined;
  providerType?: TtsProviderType | null | undefined;
  sharedProviders?: readonly SharedProviderTypeResolverEntry[];
}): TtsProviderType {
  const fromRef = resolveProviderType(input.providerRef, input.sharedProviders ?? []);
  if (fromRef !== 'unknown') return fromRef;
  return isBuiltInTtsProviderId(input.providerType) ? input.providerType : 'unknown';
}

export function resolveTtsModelForProvider(input: ResolveTtsModelForProviderInput): string {
  const providerDefaults = resolveProviderDefaults({
    providerRef: input.providerRef,
    providerType: input.providerType,
    sharedProviders: input.sharedProviders,
    fallbackProviderRef: input.fallbackProviderRef,
  });
  const requested = typeof input.model === 'string' ? input.model.trim() : '';
  if (input.showAllProviderModels === false) {
    return providerDefaults.defaultModel || requested;
  }
  return requested || providerDefaults.defaultModel;
}

export function resolveTtsProviderModelPolicy(input: ResolveTtsPolicyInput): TtsProviderModelPolicy {
  const providerRef = input.providerRef || '';
  const providerType = resolveEffectiveProviderType({
    providerRef,
    providerType: input.providerType,
    sharedProviders: input.sharedProviders,
  });
  const model = input.model || '';
  const isResolvedProviderType = isBuiltInTtsProviderId(providerType);
  const isKokoro = isKokoroModel(model);
  const maxVoices = isResolvedProviderType ? getMaxVoicesForProvider(providerType, model) : 1;

  return {
    providerRef,
    providerType,
    isResolvedProviderType,
    model,
    isKokoroModel: isKokoro,
    maxVoices,
    supportsNativeModelSpeed: isResolvedProviderType
      ? supportsNativeModelSpeed(providerType, model)
      : false,
    supportsInstructions: supportsTtsInstructions(model),
    supportsCustomModel: isResolvedProviderType
      ? providerSupportsCustomModel(providerType)
      : false,
    defaultVoices: isResolvedProviderType ? getDefaultVoices(providerType, model) : [],
    voiceSource: isResolvedProviderType ? resolveVoiceSource(providerType, model) : 'static',
  };
}
