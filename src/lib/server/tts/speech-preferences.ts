import { resolveProviderDefaults } from '@openreader/tts/provider-policy';
import { APP_CONFIG_DEFAULTS, type AppConfigValues } from '@/types/config';
import { sanitizePreferencesPatch, type PreferenceNormalizationContext } from '@/lib/server/user/preferences-normalize';
import type { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import type { AdminProviderRecord } from '@/lib/server/admin/providers';

/** Shared selection policy for saved-settings playback and public voice discovery. */
export function resolveSpeechPreferences(value: unknown, runtime: Awaited<ReturnType<typeof getResolvedRuntimeConfig>>, providers: AdminProviderRecord[]) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = {}; }
  }
  const normalization: PreferenceNormalizationContext = {
    showAllProviderModels: runtime.showAllProviderModels,
    sharedProviders: providers.filter(provider => provider.enabled).map(provider => ({
      slug: provider.slug, providerType: provider.providerType, defaultModel: provider.defaultModel,
      defaultInstructions: provider.defaultInstructions, defaultModelOptions: provider.defaultModelOptions,
    })),
  };
  const patch = sanitizePreferencesPatch(value, normalization, { fillMissingProvider: true }).patch;
  const preferences: AppConfigValues = { ...APP_CONFIG_DEFAULTS, ...patch };
  const provider = resolveProviderDefaults({ providerRef: preferences.providerRef, providerType: preferences.providerType,
    sharedProviders: normalization.sharedProviders, fallbackProviderRef: runtime.defaultTtsProvider });
  return { preferences, provider, normalization };
}
