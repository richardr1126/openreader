'use client';

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Button, Input, Select, Textarea } from '@/components/ui';
import { useConfig } from '@/contexts/ConfigContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { resolveTtsSettingsViewModel } from '@/lib/client/settings/tts-settings';
import type { TtsProviderType } from '@openreader/tts/provider-catalog';
import {
  resolveEffectiveProviderType,
  resolveProviderDefaults,
  resolveTtsProviderModelPolicy,
} from '@openreader/tts/provider-policy';

const fieldLabelClass = 'block text-[11px] font-semibold uppercase tracking-wide text-soft';

export function ProviderSettingsPanel({
  modalOpen,
  onSaved,
}: {
  modalOpen: boolean;
  onSaved: () => void;
}) {
  const runtimeConfig = useRuntimeConfig();
  const { providerRef, providerType, ttsModel, ttsInstructions, updateConfigKey } = useConfig();
  const { providers: sharedProviders, isLoading: sharedProvidersLoading } = useSharedProviders();
  const [localProviderRef, setLocalProviderRef] = useState(providerRef);
  const [localProviderType, setLocalProviderType] = useState<TtsProviderType>(providerType);
  const [modelValue, setModelValue] = useState(ttsModel);
  const [customModelInput, setCustomModelInput] = useState('');
  const [localInstructions, setLocalInstructions] = useState(ttsInstructions);

  const viewModel = useMemo(() => resolveTtsSettingsViewModel({
    providerRef: localProviderRef,
    providerType: localProviderType,
    modelValue,
    customModelInput,
    showAllProviderModels: runtimeConfig.showAllProviderModels,
    sharedProviders,
  }), [
    customModelInput,
    localProviderRef,
    localProviderType,
    modelValue,
    runtimeConfig.showAllProviderModels,
    sharedProviders,
  ]);

  const selectedProvider = viewModel.providers.find(
    (provider) => provider.id === localProviderRef,
  ) ?? viewModel.providers[0];
  const selectedModel = viewModel.models.find(
    (model) => model.id === viewModel.selectedModelId,
  ) ?? viewModel.models[0];
  const selectedModelVersion = selectedModel?.id?.includes(':')
    ? selectedModel.id.slice(selectedModel.id.indexOf(':'))
    : '';
  const effectiveProviderType = resolveEffectiveProviderType({
    providerRef: viewModel.selectedProviderRef,
    providerType: localProviderType,
    sharedProviders,
  });
  const providerModelPolicy = resolveTtsProviderModelPolicy({
    providerRef: viewModel.selectedProviderRef,
    providerType: effectiveProviderType,
    model: modelValue,
    sharedProviders,
  });

  useEffect(() => {
    if (modalOpen) return;
    setLocalProviderRef(providerRef);
    setLocalProviderType(providerType);
    setModelValue(ttsModel);
    setLocalInstructions(ttsInstructions);
  }, [modalOpen, providerRef, providerType, ttsInstructions, ttsModel]);

  useEffect(() => {
    if (!viewModel.models.some((model) => model.id === modelValue) && modelValue !== '') {
      setCustomModelInput(modelValue);
    } else {
      setCustomModelInput('');
    }
  }, [modelValue, viewModel.models]);

  useEffect(() => {
    if (selectedProvider || viewModel.providers.length === 0) return;

    const fallback = viewModel.providers[0];
    const defaults = resolveProviderDefaults({
      providerRef: fallback.id,
      providerType: fallback.providerType,
      sharedProviders,
    });
    setLocalProviderRef(fallback.id);
    setLocalProviderType(defaults.providerType);
    setModelValue(defaults.defaultModel);
    setLocalInstructions(defaults.defaultInstructions);
    setCustomModelInput('');
  }, [selectedProvider, sharedProviders, viewModel.providers]);

  const reset = () => {
    const defaults = resolveProviderDefaults({
      providerRef: runtimeConfig.defaultTtsProvider,
      sharedProviders,
    });
    setLocalProviderRef(defaults.providerRef);
    setLocalProviderType(defaults.providerType);
    setModelValue(defaults.defaultModel);
    setCustomModelInput('');
    setLocalInstructions(defaults.defaultInstructions);
  };

  const save = async () => {
    const defaults = resolveProviderDefaults({
      providerRef: viewModel.selectedProviderRef,
      providerType: viewModel.selectedProviderType,
      sharedProviders,
    });
    try {
      await updateConfigKey('providerRef', viewModel.selectedProviderRef);
      await updateConfigKey('providerType', viewModel.selectedProviderType);
      const finalModel = runtimeConfig.showAllProviderModels
        ? (viewModel.selectedModelId === 'custom' ? customModelInput.trim() : modelValue)
        : defaults.defaultModel;
      await updateConfigKey('ttsModel', finalModel);
      await updateConfigKey('ttsInstructions', localInstructions);
    } catch (error) {
      console.error('Failed to save TTS settings:', error);
      toast.error('Could not save TTS settings. Please try again.');
      return;
    }
    onSaved();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className={fieldLabelClass}>TTS Provider</label>
        {sharedProvidersLoading ? (
          <p className="text-xs text-soft">Loading providers…</p>
        ) : viewModel.providers.length === 0 ? (
          <p className="text-xs text-accent">
            No shared provider is configured. Ask an admin to add one.
          </p>
        ) : (
          <Select
            value={selectedProvider!}
            options={viewModel.providers}
            getOptionKey={(provider) => provider.id}
            renderValue={(provider) => provider.name}
            renderOption={(provider, { selected }) => (
              <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                {provider.name}
              </span>
            )}
            onChange={(provider) => {
              const defaults = resolveProviderDefaults({
                providerRef: provider.id,
                providerType: provider.providerType,
                sharedProviders,
              });
              setLocalProviderRef(provider.id);
              setLocalProviderType(defaults.providerType);
              setModelValue(defaults.defaultModel);
              setLocalInstructions(defaults.defaultInstructions);
              setCustomModelInput('');
            }}
          />
        )}
      </div>

      {viewModel.selectedSharedProvider && (
        <p className="text-xs text-soft">
          This is a shared provider configured by an admin. API key and base URL are managed server-side.
        </p>
      )}

      <div className="space-y-1.5">
        <label className={fieldLabelClass}>TTS Model</label>
        {!runtimeConfig.showAllProviderModels && (
          <p className="text-xs text-soft">
            This instance restricts model selection to each provider&apos;s default model.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Select
            value={selectedModel}
            options={viewModel.models}
            getOptionKey={(model) => model.id}
            renderValue={(model) => (
              <span className="block">
                <span className="block truncate">{model.name}</span>
                {selectedModelVersion && (
                  <span className="block truncate text-xs text-soft">{selectedModelVersion}</span>
                )}
              </span>
            )}
            renderOption={(model, { selected }) => (
              <span className={`block ${selected ? 'font-medium' : 'font-normal'}`}>
                <span className="block truncate">{model.name}</span>
                {model.id.includes(':') && (
                  <span className="block truncate text-xs text-soft">
                    {model.id.slice(model.id.indexOf(':'))}
                  </span>
                )}
              </span>
            )}
            onChange={(model) => {
              if (model.id === 'custom') {
                setModelValue(customModelInput);
              } else {
                setModelValue(model.id);
                setCustomModelInput('');
              }
            }}
          />

          {viewModel.supportsCustomModel && viewModel.selectedModelId === 'custom' && (
            <Input
              type="text"
              value={customModelInput}
              onChange={(event) => {
                setCustomModelInput(event.target.value);
                setModelValue(event.target.value);
              }}
              placeholder="Enter custom model name"
            />
          )}
        </div>
      </div>

      {providerModelPolicy.supportsInstructions && (
        <div className="space-y-1.5">
          <label className={fieldLabelClass}>TTS Instructions</label>
          <Textarea
            value={localInstructions}
            onChange={(event) => setLocalInstructions(event.target.value)}
            placeholder="Enter instructions for the TTS model"
            className="h-24 resize-none"
          />
        </div>
      )}

      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="secondary" size="md" onClick={reset}>
          Reset
        </Button>
        <Button
          data-testid="settings-save-button"
          type="button"
          variant="primary"
          size="md"
          disabled={!viewModel.canSubmit || sharedProvidersLoading}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
