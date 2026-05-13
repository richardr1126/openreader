import {
  TTS_PROVIDER_DEFINITIONS,
  providerSupportsCustomModel,
  resolveProviderModels,
  type TtsModelDefinition,
  type TtsProviderDefinition,
  type TtsProviderId,
} from '@/lib/shared/tts-provider-catalog';
import type { SharedProviderEntry } from '@/hooks/useSharedProviders';

export interface ResolveTtsSettingsViewModelOptions {
  provider: string;
  apiKey?: string;
  modelValue: string;
  customModelInput: string;
  showAllDeepInfra: boolean;
  sharedProviders?: SharedProviderEntry[];
  allowBuiltInProviders?: boolean;
}

export interface ProviderPickerOption {
  id: string;
  name: string;
  /** Underlying built-in provider type. Same as `id` for built-ins; mapped from `providerType` for admin shared instances. */
  providerType: TtsProviderId;
  /** True when this picker entry represents an admin-configured shared provider. */
  shared: boolean;
}

export interface TtsSettingsViewModel {
  providers: ProviderPickerOption[];
  models: TtsModelDefinition[];
  supportsCustomModel: boolean;
  selectedModelId: string;
  canSubmit: boolean;
  /** The matched shared provider entry, if the current selection is a shared slug. */
  selectedSharedProvider: SharedProviderEntry | null;
}

const BUILT_IN_DEFINITION_BY_ID: Map<string, TtsProviderDefinition> = new Map(
  TTS_PROVIDER_DEFINITIONS.map((def) => [def.id, def]),
);

export function resolveTtsSettingsViewModel({
  provider,
  apiKey,
  modelValue,
  customModelInput,
  showAllDeepInfra,
  sharedProviders = [],
  allowBuiltInProviders = true,
}: ResolveTtsSettingsViewModelOptions): TtsSettingsViewModel {
  const builtInOptions: ProviderPickerOption[] = allowBuiltInProviders
    ? TTS_PROVIDER_DEFINITIONS.map((def) => ({
      id: def.id,
      name: def.name,
      providerType: def.id,
      shared: false,
    }))
    : [];
  const sharedOptions: ProviderPickerOption[] = sharedProviders.map((entry) => ({
    id: entry.slug,
    name: `${entry.displayName} (shared)`,
    providerType: entry.providerType,
    shared: true,
  }));
  const providers = [...sharedOptions, ...builtInOptions];
  const selectedProviderId = providers.some((opt) => opt.id === provider)
    ? provider
    : providers[0]?.id ?? '';

  // Determine the *effective* built-in provider type used for model resolution.
  const selectedShared = sharedProviders.find((p) => p.slug === selectedProviderId) ?? null;
  const effectiveProvider = selectedShared ? selectedShared.providerType : selectedProviderId;

  const models = resolveProviderModels(effectiveProvider, {
    apiKey,
    showAllDeepInfra,
  });
  const supportsCustomModel =
    BUILT_IN_DEFINITION_BY_ID.has(effectiveProvider) &&
    providerSupportsCustomModel(effectiveProvider);
  const isPreset = models.some((model) => model.id === modelValue);
  const selectedModelId = isPreset
    ? modelValue
    : supportsCustomModel
      ? 'custom'
      : models[0]?.id ?? '';
  const canSubmit = providers.length > 0 && (
    selectedModelId !== 'custom' ||
    (supportsCustomModel && customModelInput.trim().length > 0)
  );

  return {
    providers,
    models,
    supportsCustomModel,
    selectedModelId,
    canSubmit,
    selectedSharedProvider: selectedShared,
  };
}
