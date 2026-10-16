'use client';

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ChatBubbleIcon, CubeIcon, MicrophoneIcon, ServerStackIcon, SpeedometerIcon } from '@/components/icons/Icons';
import { Button, Input, RangeInput, RowIcon, Section, Select, SelectOptionDetail, SettingRow, Textarea } from '@/components/ui';
import { LoadingSpinner } from '@/components/Spinner';
import { useConfig } from '@/contexts/ConfigContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { useVoiceManagement } from '@/hooks/audio/useVoiceManagement';
import { formatModelSpeed } from '@/lib/client/tts/voice-draft';
import { MODEL_SPEED_MAX, MODEL_SPEED_MIN } from '@/lib/shared/document-settings';
import { resolveTtsSettingsViewModel } from '@/lib/client/settings/tts-settings';
import type { TtsProviderType } from '@openreader/tts/provider-catalog';
import {
  resolveEffectiveProviderType,
  resolveProviderDefaults,
  resolveTtsProviderModelPolicy,
} from '@openreader/tts/provider-policy';


export function ProviderSettingsPanel({
  active = true,
  onSaved,
}: {
  active?: boolean;
  onSaved?: () => void;
}) {
  const runtimeConfig = useRuntimeConfig();
  const {
    providerRef,
    providerType,
    ttsModel,
    ttsInstructions,
    voice,
    voiceSpeed,
    updateConfig,
    isLoading: configLoading,
  } = useConfig();
  const [saving, setSaving] = useState(false);
  const { providers: sharedProviders, isLoading: sharedProvidersLoading } = useSharedProviders();
  const [localProviderRef, setLocalProviderRef] = useState(providerRef);
  const [localProviderType, setLocalProviderType] = useState<TtsProviderType>(providerType);
  const [modelValue, setModelValue] = useState(ttsModel);
  const [customModelInput, setCustomModelInput] = useState('');
  const [localInstructions, setLocalInstructions] = useState(ttsInstructions);
  const [localVoice, setLocalVoice] = useState(voice);
  const [localSpeed, setLocalSpeed] = useState(voiceSpeed);
  const [hydrated, setHydrated] = useState(false);

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
  const { availableVoices, voicesPending } = useVoiceManagement(
    viewModel.selectedProviderRef,
    effectiveProviderType,
    modelValue,
  );
  const shownVoice = localVoice || availableVoices[0] || '';
  // A saved blend (e.g. Kokoro "a(0.5)+b(0.5)") is kept as its own option.
  const voiceOptions = shownVoice && !availableVoices.includes(shownVoice)
    ? [shownVoice, ...availableVoices]
    : availableVoices;
  const chooseProviderModel = (next: { providerRef?: string; providerType?: TtsProviderType; model: string }) => {
    if (next.providerRef !== undefined) setLocalProviderRef(next.providerRef);
    if (next.providerType !== undefined) setLocalProviderType(next.providerType);
    setModelValue(next.model);
    // Voices belong to a provider and model; the new list supplies the default.
    setLocalVoice('');
  };

  useEffect(() => {
    if (configLoading || (active && hydrated)) return;
    setLocalProviderRef(providerRef);
    setLocalProviderType(providerType);
    setModelValue(ttsModel);
    setCustomModelInput(ttsModel);
    setLocalInstructions(ttsInstructions);
    setLocalVoice(voice);
    setLocalSpeed(voiceSpeed);
    setHydrated(true);
  }, [active, configLoading, hydrated, providerRef, providerType, ttsInstructions, ttsModel, voice, voiceSpeed]);

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
    chooseProviderModel({ providerRef: fallback.id, providerType: defaults.providerType, model: defaults.defaultModel });
    setLocalInstructions(defaults.defaultInstructions);
    setCustomModelInput('');
  }, [selectedProvider, sharedProviders, viewModel.providers]);

  const reset = () => {
    const defaults = resolveProviderDefaults({
      providerRef: runtimeConfig.defaultTtsProvider,
      sharedProviders,
    });
    chooseProviderModel({ providerRef: defaults.providerRef, providerType: defaults.providerType, model: defaults.defaultModel });
    setCustomModelInput('');
    setLocalInstructions(defaults.defaultInstructions);
    setLocalSpeed(1);
  };

  const save = async () => {
    const defaults = resolveProviderDefaults({
      providerRef: viewModel.selectedProviderRef,
      providerType: viewModel.selectedProviderType,
      sharedProviders,
    });
    const finalModel = runtimeConfig.showAllProviderModels
      ? (viewModel.selectedModelId === 'custom' ? customModelInput.trim() : modelValue)
      : defaults.defaultModel;
    setSaving(true);
    try {
      // One request; key order matters, so the voice lands under the new provider and model.
      await updateConfig({
        providerRef: viewModel.selectedProviderRef,
        providerType: viewModel.selectedProviderType,
        ttsModel: finalModel,
        ttsInstructions: localInstructions,
        ...(shownVoice ? { voice: shownVoice } : {}),
        ...(providerModelPolicy.supportsNativeModelSpeed ? { voiceSpeed: localSpeed } : {}),
      });
    } catch (error) {
      console.error('Failed to save TTS settings:', error);
      toast.error('Could not save TTS settings. Please try again.');
      return;
    } finally {
      setSaving(false);
    }
    toast.success('Voice settings saved');
    onSaved?.();
  };

  if (configLoading || !hydrated) {
    return (
      <div className="space-y-3" aria-label="Loading voice settings" aria-busy="true">
        <div className="h-3 w-24 animate-pulse rounded bg-offbase" />
        <div className="h-10 w-full animate-pulse rounded-md bg-offbase" />
        <div className="h-3 w-20 animate-pulse rounded bg-offbase" />
        <div className="h-10 w-full animate-pulse rounded-md bg-offbase" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Section title="Provider" variant="group">
        <SettingRow label="Provider" icon={<ServerStackIcon />}>
          {sharedProvidersLoading ? (
            <p className="text-xs text-soft">Loading providers…</p>
          ) : viewModel.providers.length === 0 ? (
            <p className="text-xs text-accent">
              No shared provider is configured. Ask an admin to add one.
            </p>
          ) : (
            <Select
              aria-label="Provider"
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
                chooseProviderModel({ providerRef: provider.id, providerType: defaults.providerType, model: defaults.defaultModel });
                setLocalInstructions(defaults.defaultInstructions);
                setCustomModelInput('');
              }}
            />
          )}
        </SettingRow>

        <SettingRow
          label="Model"
          icon={<CubeIcon />}
          description={runtimeConfig.showAllProviderModels ? undefined : 'Model is fixed by your admin.'}
        >
          <div className="flex flex-col gap-2">
            <Select
              aria-label="Model"
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
                    <SelectOptionDetail className="truncate">
                      {model.id.slice(model.id.indexOf(':'))}
                    </SelectOptionDetail>
                  )}
                </span>
              )}
              onChange={(model) => {
                if (model.id === 'custom') {
                  chooseProviderModel({ model: customModelInput });
                } else {
                  chooseProviderModel({ model: model.id });
                  setCustomModelInput('');
                }
              }}
            />

            {viewModel.supportsCustomModel && viewModel.selectedModelId === 'custom' && (
              <Input
                type="text"
                aria-label="Custom model name"
                value={customModelInput}
                onChange={(event) => {
                  setCustomModelInput(event.target.value);
                  chooseProviderModel({ model: event.target.value });
                }}
                placeholder="Custom model name"
              />
            )}
          </div>
        </SettingRow>
      </Section>

      <Section title="Default voice" variant="group" subtitle="Books use this unless you pick a voice for one in the reader.">
        <SettingRow label="Voice" icon={<MicrophoneIcon />}>
          {voicesPending ? (
            <p className="text-xs text-soft">Loading voices…</p>
          ) : voiceOptions.length === 0 ? (
            <p className="text-xs text-soft">No voices are available for this model.</p>
          ) : (
            <Select
              aria-label="Default voice"
              value={shownVoice}
              options={voiceOptions}
              getOptionKey={(option) => option}
              renderValue={(option) => <span className="block truncate">{option}</span>}
              renderOption={(option, { selected }) => (
                <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>{option}</span>
              )}
              onChange={setLocalVoice}
            />
          )}
        </SettingRow>

        {providerModelPolicy.supportsNativeModelSpeed && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <RowIcon><SpeedometerIcon /></RowIcon>
              <label htmlFor="default-model-speed" className="flex-1 text-sm font-medium text-foreground">Model speed</label>
              <span className="text-sm tabular-nums text-soft">{formatModelSpeed(localSpeed)}</span>
            </div>
            <RangeInput
              id="default-model-speed"
              min={MODEL_SPEED_MIN}
              max={MODEL_SPEED_MAX}
              step={0.1}
              value={localSpeed}
              onChange={(event) => setLocalSpeed(Number(Number(event.target.value).toFixed(2)))}
            />
          </div>
        )}
      </Section>

      {providerModelPolicy.supportsInstructions && (
        <Section title="Instructions" variant="group">
          <SettingRow label="Voice instructions" icon={<ChatBubbleIcon />} stacked>
            <Textarea
              aria-label="Voice instructions"
              value={localInstructions}
              onChange={(event) => setLocalInstructions(event.target.value)}
              placeholder="Optional voice instructions"
              className="h-24 resize-none"
            />
          </SettingRow>
        </Section>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="md" onClick={reset} disabled={saving}>
          Reset
        </Button>
        <Button
          data-testid="settings-save-button"
          type="button"
          variant="primary"
          size="md"
          // While saving the button stays at full strength (not the faded
          // disabled look) and ignores clicks, so it reads as busy.
          disabled={!saving && (!viewModel.canSubmit || sharedProvidersLoading)}
          aria-disabled={saving || undefined}
          aria-busy={saving}
          onClick={saving ? undefined : save}
          className={saving ? 'min-w-[6.5rem] cursor-progress' : 'min-w-[6.5rem]'}
        >
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <LoadingSpinner className="h-3.5 w-3.5" />
              Saving…
            </span>
          ) : 'Save'}
        </Button>
      </div>
    </div>
  );
}
