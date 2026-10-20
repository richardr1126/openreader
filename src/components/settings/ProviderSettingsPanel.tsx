'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ChatBubbleIcon, CubeIcon, ServerStackIcon, SpeedometerIcon } from '@/components/icons/Icons';
import { InlineButton, Input, RangeInput, RowIcon, SaveBar, Section, Select, SelectOptionDetail, SettingRow, Textarea } from '@/components/ui';
import { SELECTION_PREVIEW_KEY, VoicePicker, VoicePreviewButton, type VoicePickerPreview } from '@/components/player/VoicePicker';
import { useConfig } from '@/contexts/ConfigContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { useVoiceManagement } from '@/hooks/audio/useVoiceManagement';
import { useVoicePreview } from '@/hooks/audio/useVoicePreview';
import { formatModelSpeed } from '@/lib/client/tts/voice-draft';
import { MODEL_SPEED_MAX, MODEL_SPEED_MIN } from '@/lib/shared/document-settings';
import { buildVoicePreviewText } from '@/lib/shared/tts-voice-preview';
import { resolveTtsLanguage } from '@openreader/tts/language';
import { resolveTtsSettingsViewModel } from '@/lib/client/settings/tts-settings';
import type { TtsProviderType } from '@openreader/tts/provider-catalog';
import {
  resolveEffectiveProviderType,
  resolveProviderDefaults,
  resolveTtsProviderModelPolicy,
} from '@openreader/tts/provider-policy';

const noop = () => {};

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

  const loadSaved = useCallback(() => {
    setLocalProviderRef(providerRef);
    setLocalProviderType(providerType);
    setModelValue(ttsModel);
    setCustomModelInput(ttsModel);
    setLocalInstructions(ttsInstructions);
    setLocalVoice(voice);
    setLocalSpeed(voiceSpeed);
  }, [providerRef, providerType, ttsInstructions, ttsModel, voice, voiceSpeed]);

  useEffect(() => {
    if (configLoading || (active && hydrated)) return;
    loadSaved();
    setHydrated(true);
  }, [active, configLoading, hydrated, loadSaved]);

  // Settings has no document playing, so a preview has nothing to pause.
  const preview = useVoicePreview({ isPlaying: false, pausePlayback: noop });
  const { play: playSample, stop: stopPreview } = preview;
  useEffect(() => stopPreview, [stopPreview]);
  const playPreview = useCallback((key: string, previewVoice: string) => {
    void playSample(key, {
      settings: {
        providerRef: viewModel.selectedProviderRef,
        providerType: effectiveProviderType,
        ttsModel: modelValue,
        voice: previewVoice,
        nativeSpeed: providerModelPolicy.supportsNativeModelSpeed ? localSpeed : 1,
        ...(providerModelPolicy.supportsInstructions && localInstructions ? { ttsInstructions: localInstructions } : {}),
        language: resolveTtsLanguage({ voice: previewVoice }),
      },
      text: buildVoicePreviewText({ currentSentence: null, documentLanguage: null, voice: previewVoice }),
    });
  }, [
    effectiveProviderType,
    localInstructions,
    localSpeed,
    modelValue,
    playSample,
    providerModelPolicy.supportsInstructions,
    providerModelPolicy.supportsNativeModelSpeed,
    viewModel.selectedProviderRef,
  ]);
  const pickerPreview: VoicePickerPreview = { state: preview.state, play: playPreview, stop: stopPreview };
  const voicePickPolicy = {
    multi: providerModelPolicy.isKokoroModel && providerModelPolicy.maxVoices > 1,
    maxVoices: providerModelPolicy.maxVoices,
  };

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

  const resetToDefaults = () => {
    const defaults = resolveProviderDefaults({
      providerRef: runtimeConfig.defaultTtsProvider,
      sharedProviders,
    });
    chooseProviderModel({ providerRef: defaults.providerRef, providerType: defaults.providerType, model: defaults.defaultModel });
    setCustomModelInput('');
    setLocalInstructions(defaults.defaultInstructions);
    setLocalSpeed(1);
  };

  const finalModel = runtimeConfig.showAllProviderModels
    ? (viewModel.selectedModelId === 'custom' ? customModelInput.trim() : modelValue)
    : resolveProviderDefaults({
      providerRef: viewModel.selectedProviderRef,
      providerType: viewModel.selectedProviderType,
      sharedProviders,
    }).defaultModel;
  const dirty = viewModel.selectedProviderRef !== providerRef
    || viewModel.selectedProviderType !== providerType
    || finalModel !== ttsModel
    || localInstructions !== ttsInstructions
    || localVoice !== voice
    || (providerModelPolicy.supportsNativeModelSpeed && localSpeed !== voiceSpeed);

  const discard = () => {
    stopPreview();
    loadSaved();
  };

  const save = async () => {
    stopPreview();
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
      <Section
        title="Provider"
        variant="group"
        action={(
          <InlineButton onClick={resetToDefaults} disabled={saving} className="no-underline hover:text-accent">
            Use defaults
          </InlineButton>
        )}
      >
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

      <Section
        title="Default voice"
        variant="group"
        subtitle="Books use this unless you pick a voice for one in the reader."
        action={shownVoice ? (
          <VoicePreviewButton
            previewKey={SELECTION_PREVIEW_KEY}
            label="selection"
            preview={pickerPreview}
            voice={shownVoice}
          />
        ) : null}
      >
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

        {voicesPending ? (
          <p className="text-xs text-soft">Loading voices…</p>
        ) : (
          <VoicePicker
            voices={voiceOptions}
            value={shownVoice}
            onChange={setLocalVoice}
            pickPolicy={voicePickPolicy}
            groupByLanguage={providerModelPolicy.isKokoroModel}
            preview={pickerPreview}
          />
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

      {dirty || saving ? (
        <SaveBar
          saving={saving}
          saveDisabled={!viewModel.canSubmit || sharedProvidersLoading}
          onDiscard={discard}
          onSave={() => void save()}
        />
      ) : null}
    </div>
  );
}
