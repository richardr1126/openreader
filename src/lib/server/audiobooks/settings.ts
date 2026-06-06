import {
  resolveTtsModelForProvider,
  resolveTtsProviderModelPolicy,
  resolveProviderDefaults,
  type ProviderDefaultResolverEntry,
} from '@/lib/shared/tts-provider-policy';
import { isBuiltInTtsProviderId, isTtsProviderType, type TtsProviderId } from '@/lib/shared/tts-provider-catalog';
import type { AudiobookGenerationSettings } from '@/types/client';
import type { TTSAudiobookFormat } from '@/types/tts';
import { resolveEffectiveTtsInstructions } from '@/lib/server/admin/tts-instructions';
import { resolvePreferredSharedProviderSlug } from '@/lib/shared/shared-provider-selection';
import { normalizeLanguageTag } from '@/lib/shared/language';

function isAudiobookFormat(value: unknown): value is TTSAudiobookFormat {
  return value === 'mp3' || value === 'm4b';
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function coerceAudiobookGenerationSettings(
  value: unknown,
  options?: {
    fallbackProviderRef?: string | null | undefined;
    sharedProviders?: readonly ProviderDefaultResolverEntry[];
  },
): { settings: AudiobookGenerationSettings | null; migrated: boolean } {
  if (typeof value !== 'object' || value === null) {
    return { settings: null, migrated: false };
  }

  const record = value as Record<string, unknown>;
  const hasLegacyProvider = typeof record.ttsProvider === 'string';
  const rawProviderRef = typeof record.providerRef === 'string'
    ? record.providerRef
    : hasLegacyProvider
      ? (record.ttsProvider as string)
      : '';

  const defaults = resolveProviderDefaults({
    providerRef: rawProviderRef,
    providerType: isTtsProviderType(record.providerType) ? record.providerType : undefined,
    sharedProviders: options?.sharedProviders,
    fallbackProviderRef: options?.fallbackProviderRef,
  });

  const ttsModel = typeof record.ttsModel === 'string' ? record.ttsModel.trim() : '';
  const voice = typeof record.voice === 'string' ? record.voice.trim() : '';
  const nativeSpeed = toFiniteNumber(record.nativeSpeed);
  const postSpeed = toFiniteNumber(record.postSpeed);
  const format = record.format;

  if (!defaults.providerRef || !ttsModel || !voice || nativeSpeed === null || postSpeed === null || !isAudiobookFormat(format)) {
    return { settings: null, migrated: false };
  }

  const settings: AudiobookGenerationSettings = {
    providerRef: defaults.providerRef,
    providerType: defaults.providerType,
    ttsModel,
    voice,
    nativeSpeed,
    postSpeed,
    format,
    ...(typeof record.ttsInstructions === 'string' ? { ttsInstructions: record.ttsInstructions } : {}),
    ...(typeof record.language === 'string' ? { language: normalizeLanguageTag(record.language) } : {}),
  };

  const migrated =
    hasLegacyProvider
    || typeof record.providerRef !== 'string'
    || !isTtsProviderType(record.providerType)
    || record.providerRef !== defaults.providerRef
    || record.providerType !== defaults.providerType;

  return { settings, migrated };
}

export type SharedProviderPolicyEntry = {
  slug: string;
  providerType: TtsProviderId;
  defaultModel: string | null;
  defaultInstructions: string | null;
};

function normalizeNativeSpeedForSettings(settings: AudiobookGenerationSettings): AudiobookGenerationSettings {
  return resolveTtsProviderModelPolicy({
    providerRef: settings.providerRef,
    providerType: settings.providerType,
    model: settings.ttsModel,
  }).supportsNativeModelSpeed
    ? settings
    : { ...settings, nativeSpeed: 1 };
}

function resolveRestrictedProviderRef(
  providerRef: string,
  fallbackProviderRef: string,
  sharedProviders: SharedProviderPolicyEntry[],
): string {
  const preferred = resolvePreferredSharedProviderSlug({
    providers: sharedProviders,
    requestedSlug: isBuiltInTtsProviderId(providerRef) ? null : providerRef,
    runtimeDefaultSlug: isBuiltInTtsProviderId(fallbackProviderRef) ? null : fallbackProviderRef,
  });
  return preferred || providerRef;
}

export function canonicalizeAudiobookSettingsForRuntime(input: {
  settings: AudiobookGenerationSettings;
  restrictUserApiKeys: boolean;
  fallbackProviderRef: string;
  showAllProviderModels: boolean;
  sharedProviders: SharedProviderPolicyEntry[];
}): AudiobookGenerationSettings {
  if (!input.restrictUserApiKeys) {
    return normalizeNativeSpeedForSettings(input.settings);
  }

  const restrictedProviderRef = resolveRestrictedProviderRef(
    input.settings.providerRef,
    input.fallbackProviderRef,
    input.sharedProviders,
  );
  const sharedProvider = input.sharedProviders.find((entry) => entry.slug === restrictedProviderRef);
  const providerType = sharedProvider?.providerType || input.settings.providerType;
  const ttsModel = resolveTtsModelForProvider({
    providerRef: restrictedProviderRef,
    providerType,
    model: input.settings.ttsModel,
    sharedProviders: sharedProvider ? [sharedProvider] : [],
    fallbackProviderRef: input.fallbackProviderRef,
    showAllProviderModels: input.showAllProviderModels,
  });
  const ttsInstructions = resolveEffectiveTtsInstructions({
    model: ttsModel,
    requestInstructions: input.settings.ttsInstructions,
    sharedDefaultInstructions: sharedProvider?.defaultInstructions,
  }) ?? '';

  return normalizeNativeSpeedForSettings({
    ...input.settings,
    providerRef: restrictedProviderRef,
    providerType,
    ttsModel,
    ttsInstructions,
  });
}
