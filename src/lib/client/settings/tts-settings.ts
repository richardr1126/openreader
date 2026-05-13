import {
  isBuiltInTtsProviderId,
  TTS_PROVIDER_DEFINITIONS,
  resolveProviderModels,
  type TtsModelDefinition,
  type TtsProviderDefinition,
  type TtsProviderId,
  type TtsProviderType,
} from '@/lib/shared/tts-provider-catalog';
import {
  normalizeLegacyProviderRef,
  resolveEffectiveProviderType,
  resolveProviderDefaults,
  resolveTtsModelForProvider,
  resolveTtsProviderModelPolicy,
} from '@/lib/shared/tts-provider-policy';
import type { SharedProviderEntry } from '@/hooks/useSharedProviders';

export interface ResolveTtsSettingsViewModelOptions {
  providerRef: string;
  providerType: TtsProviderType;
  apiKey?: string;
  modelValue: string;
  customModelInput: string;
  showAllDeepInfra: boolean;
  showAllProviderModels: boolean;
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
  selectedProviderRef: string;
  selectedProviderType: TtsProviderType;
}

const BUILT_IN_DEFINITION_BY_ID: Map<string, TtsProviderDefinition> = new Map(
  TTS_PROVIDER_DEFINITIONS.map((def) => [def.id, def]),
);

export function resolveTtsSettingsViewModel({
  providerRef,
  providerType,
  apiKey,
  modelValue,
  customModelInput,
  showAllDeepInfra,
  showAllProviderModels,
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
  const normalizedInputProviderRef = normalizeLegacyProviderRef(providerRef);
  const selectedProviderRef = providers.some((opt) => opt.id === normalizedInputProviderRef)
    ? normalizedInputProviderRef
    : providers[0]?.id ?? '';
  const providerSelectionChanged = selectedProviderRef !== normalizedInputProviderRef;

  const selectedShared = sharedProviders.find((p) => p.slug === selectedProviderRef) ?? null;
  const selectedProviderType = resolveEffectiveProviderType({
    providerRef: selectedProviderRef,
    providerType,
    sharedProviders,
  });
  const effectiveProviderType = selectedProviderType;
  const knownProviderType = isBuiltInTtsProviderId(effectiveProviderType)
    ? effectiveProviderType
    : null;

  const catalogModels = resolveProviderModels(knownProviderType ?? 'custom-openai', {
    apiKey,
    showAllDeepInfra,
  });
  const providerDefaults = resolveProviderDefaults({
    providerRef: selectedProviderRef,
    providerType: selectedProviderType,
    sharedProviders,
  });
  const defaultModel = resolveTtsModelForProvider({
    providerRef: selectedProviderRef,
    providerType: selectedProviderType,
    model: providerDefaults.defaultModel,
    sharedProviders,
    showAllProviderModels: false,
  });
  const models = (!showAllProviderModels && defaultModel)
    ? [{
      id: defaultModel,
      name: catalogModels.find((model) => model.id === defaultModel)?.name ?? defaultModel,
    }]
    : catalogModels;
  const supportsCustomModel = showAllProviderModels && knownProviderType
    ? BUILT_IN_DEFINITION_BY_ID.has(knownProviderType) && resolveTtsProviderModelPolicy({
      providerRef: selectedProviderRef,
      providerType: knownProviderType,
      model: modelValue,
      sharedProviders,
    }).supportsCustomModel
    : false;
  const normalizedModelValue = (() => {
    if (!showAllProviderModels) {
      return defaultModel;
    }
    const trimmedModel = modelValue.trim();
    const sharedDefault = selectedShared?.defaultModel?.trim() || providerDefaults.defaultModel;
    if (!sharedDefault) return trimmedModel;
    if (!trimmedModel) return sharedDefault;
    if ((providerSelectionChanged || normalizedInputProviderRef === 'default-openai') && trimmedModel === 'kokoro') {
      return sharedDefault;
    }
    return trimmedModel;
  })();
  const isPreset = models.some((model) => model.id === normalizedModelValue);
  const selectedModelId = isPreset
    ? normalizedModelValue
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
    selectedProviderRef,
    selectedProviderType,
  };
}
