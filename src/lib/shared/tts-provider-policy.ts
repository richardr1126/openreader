import { getMaxVoicesForProvider, isKokoroModel } from '@/lib/shared/kokoro';
import {
  getDefaultVoices,
  isBuiltInTtsProviderId,
  providerSupportsCustomModel,
  resolveProviderType,
  resolveVoiceSource,
  supportsNativeModelSpeed,
  supportsTtsInstructions,
  REPLICATE_KOKORO_82M_VERSIONED_MODEL,
  type SharedProviderTypeResolverEntry,
  type TtsProviderId,
  type TtsProviderType,
  type TtsVoiceSource,
} from '@/lib/shared/tts-provider-catalog';

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
  if (providerType === 'replicate') return REPLICATE_KOKORO_82M_VERSIONED_MODEL;
  if (providerType === 'speech-sdk') return 'openai/gpt-4o-mini-tts';
  return 'kokoro';
}

export function defaultBaseUrlForProviderType(providerType: TtsProviderId): string {
  if (providerType === 'openai') return 'https://api.openai.com/v1';
  if (providerType === 'deepinfra') return 'https://api.deepinfra.com/v1/openai';
  return '';
}

export function defaultVoiceForProviderType(providerType: TtsProviderId): string {
  if (providerType === 'openai') return 'alloy';
  if (providerType === 'deepinfra') return 'af_bella';
  if (providerType === 'speech-sdk') return 'alloy';
  return 'af_sarah';
}

export function normalizeLegacyProviderRef(
  providerRef: string | null | undefined,
  fallbackProviderRef?: string | null | undefined,
): string {
  const raw = typeof providerRef === 'string' ? providerRef.trim() : '';
  if (!raw) return '';
  if (raw !== 'default-openai') return raw;
  const fallback = typeof fallbackProviderRef === 'string' ? fallbackProviderRef.trim() : '';
  if (fallback && fallback !== 'default-openai') return fallback;
  return raw;
}

export function resolveProviderDefaults(input: {
  providerRef: string | null | undefined;
  providerType?: TtsProviderType | null | undefined;
  sharedProviders?: readonly ProviderDefaultResolverEntry[];
  fallbackProviderRef?: string | null | undefined;
}): ResolvedProviderDefaults {
  const normalizedProviderRef = normalizeLegacyProviderRef(input.providerRef, input.fallbackProviderRef);
  const fallbackRef = typeof input.fallbackProviderRef === 'string' ? input.fallbackProviderRef.trim() : '';
  const providerRef = normalizedProviderRef || fallbackRef;
  const sharedProviders = input.sharedProviders ?? [];
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
