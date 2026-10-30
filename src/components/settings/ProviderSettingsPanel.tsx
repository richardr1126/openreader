'use client';
import { SpeechTextControls } from './SpeechTextControls';
import { VoiceCustomizationControls } from './VoiceCustomizationControls';
import { OpenRouterOptionsControls, readableOpenRouterOptions } from './OpenRouterOptionsControls';
import { useOpenRouterModels } from '@/hooks/useOpenRouterModels';
import { normalizeOpenRouterOptions } from '@openreader/tts/openrouter';
import { AdvancedSettings } from './AdvancedSettings';
import { MaxSegmentLengthControl } from './MaxSegmentLengthControl';
import { PdfBlockKindControls } from './PdfBlockKindControls';
import { VOICE_CUSTOMIZATION_FIELDS } from '@openreader/tts/voice-customization';

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ChatBubbleIcon, CubeIcon, ServerStackIcon, SpeedometerIcon } from '@/components/icons/Icons';
import { Button, InlineButton, Input, RangeInput, RowIcon, SaveBar, Section, Select, SelectOptionDetail, SettingRow, Textarea } from '@/components/ui';
import { ProviderSelect } from '@/components/providers/ProviderSelect';
import { SELECTION_PREVIEW_KEY, VoicePicker, VoicePreviewButton, type VoicePickerPreview } from '@/components/player/VoicePicker';
import { useConfig } from '@/contexts/ConfigContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { useVoiceManagement } from '@/hooks/audio/useVoiceManagement';
import { useVoicePreview } from '@/hooks/audio/useVoicePreview';
import { useVoiceFavorites } from '@/hooks/useVoiceFavorites';
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
    ttsModelOptions,
    voice,
    voiceSpeed,
    speechText,
    voiceCustomization,
    ttsSegmentMaxBlockLength,
    pdfSkipBlockKinds,
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
  const [localModelOptions, setLocalModelOptions] = useState('');
  const catalog = useOpenRouterModels(localProviderType === 'openrouter');
  const [localVoice, setLocalVoice] = useState(voice);
  const [localSpeed, setLocalSpeed] = useState(voiceSpeed);
  const [localSpeechText, setLocalSpeechText] = useState(speechText);
  const [localCustomization, setLocalCustomization] = useState(voiceCustomization);
  const [localMaxSegmentLength, setLocalMaxSegmentLength] = useState(ttsSegmentMaxBlockLength);
  const [localPdfSkipKinds, setLocalPdfSkipKinds] = useState(pdfSkipBlockKinds);
  const [hydrated, setHydrated] = useState(false);

  const viewModel = useMemo(() => resolveTtsSettingsViewModel({
    providerRef: localProviderRef,
    providerType: localProviderType,
    modelValue,
    customModelInput,
    showAllProviderModels: runtimeConfig.showAllProviderModels,
    sharedProviders,
    openRouterModels: catalog.data,
  }), [
    customModelInput,
    localProviderRef,
    localProviderType,
    modelValue,
    runtimeConfig.showAllProviderModels,
    sharedProviders,
    catalog.data,
  ]);

  // The picker can resolve an empty or stale saved model to a preset. Every
  // consumer must use that displayed choice, including the first capability
  // check, rather than waiting for a click to update the raw draft value.
  const finalModel = viewModel.selectedModelId === 'custom'
    ? customModelInput.trim()
    : viewModel.selectedModelId;

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
    model: finalModel,
    sharedProviders,
  });
  const { availableVoices, voicesPending } = useVoiceManagement(
    viewModel.selectedProviderRef,
    effectiveProviderType,
    finalModel,
  );
  const shownVoice = localVoice || availableVoices[0] || '';
  const favorites = useVoiceFavorites(viewModel.selectedProviderRef, finalModel);
  // A saved blend (e.g. Kokoro "a(0.5)+b(0.5)") is kept as its own option.
  const voiceOptions = shownVoice && !availableVoices.includes(shownVoice)
    ? [shownVoice, ...availableVoices]
    : availableVoices;
  /** What the admin set for a provider; the draft starts from it and saving it unchanged keeps following it. */
  const providerDefaultsFor = useCallback((ref: string, type: TtsProviderType, model: string) => {
    const defaults = resolveProviderDefaults({ providerRef: ref, providerType: type, sharedProviders });
    return {
      instructions: defaults.defaultInstructions,
      modelOptions: readableOpenRouterOptions(readModelOptions(defaults.providerType, defaults.defaultModelOptions, model).normalized),
    };
  }, [sharedProviders]);
  const chooseProviderModel = useCallback((next: { providerRef?: string; providerType?: TtsProviderType; model: string }) => {
    if (next.providerRef !== undefined) setLocalProviderRef(next.providerRef);
    if (next.providerType !== undefined) setLocalProviderType(next.providerType);
    setModelValue(next.model);
    setLocalModelOptions(providerDefaultsFor(next.providerRef ?? localProviderRef, next.providerType ?? localProviderType, next.model).modelOptions);
    // Voices belong to a provider and model; the new list supplies the default.
    setLocalVoice('');
  }, [localProviderRef, localProviderType, providerDefaultsFor]);

  const loadSaved = useCallback(() => {
    setLocalProviderRef(providerRef);
    setLocalProviderType(providerType);
    setModelValue(ttsModel);
    setCustomModelInput(ttsModel);
    setLocalInstructions(ttsInstructions);
    setLocalModelOptions(readableOpenRouterOptions(ttsModelOptions) || providerDefaultsFor(providerRef, providerType, ttsModel).modelOptions);
    setLocalVoice(voice);
    setLocalSpeed(voiceSpeed);
    setLocalSpeechText(speechText);
    setLocalCustomization(voiceCustomization);
    setLocalMaxSegmentLength(ttsSegmentMaxBlockLength);
    setLocalPdfSkipKinds(pdfSkipBlockKinds);
  }, [providerRef, providerType, providerDefaultsFor, ttsInstructions, ttsModelOptions, ttsModel, voice, voiceSpeed, speechText, voiceCustomization, ttsSegmentMaxBlockLength, pdfSkipBlockKinds]);

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
    const previewOptions = readModelOptions(effectiveProviderType, localModelOptions, finalModel);
    if (previewOptions.error) { toast.error(previewOptions.error); return; }
    void playSample(key, {
      settings: {
        providerRef: viewModel.selectedProviderRef,
        providerType: effectiveProviderType,
        ttsModel: finalModel,
        ...(previewOptions.normalized ? { ttsModelOptions: previewOptions.normalized } : {}),
        voice: previewVoice,
        nativeSpeed: providerModelPolicy.supportsNativeModelSpeed ? localSpeed : 1,
        ...(providerModelPolicy.supportsInstructions && localInstructions ? { ttsInstructions: localInstructions } : {}),
        language: resolveTtsLanguage({ voice: previewVoice }),
        voiceCustomization: localCustomization,
      },
      text: buildVoicePreviewText({ currentSentence: null, documentLanguage: null, voice: previewVoice }),
    });
  }, [
    effectiveProviderType,
    localInstructions,
    localModelOptions,
    localSpeed,
    localCustomization,
    finalModel,
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
  }, [chooseProviderModel, selectedProvider, sharedProviders, viewModel.providers]);

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

  const modelOptions = readModelOptions(effectiveProviderType, localModelOptions, finalModel);
  const selectedDefaults = providerDefaultsFor(viewModel.selectedProviderRef, viewModel.selectedProviderType, finalModel);
  const followsProviderInstructions = !!selectedDefaults.instructions && localInstructions.trim() === selectedDefaults.instructions.trim();
  const savedInstructions = followsProviderInstructions ? '' : localInstructions;
  const savedModelOptions = modelOptions.normalized === readModelOptions(effectiveProviderType, selectedDefaults.modelOptions, finalModel).normalized
    ? ''
    : modelOptions.normalized;
  const dirty = viewModel.selectedProviderRef !== providerRef
    || viewModel.selectedProviderType !== providerType
    || finalModel !== ttsModel
    || localInstructions !== ttsInstructions
    || !!modelOptions.error || savedModelOptions !== ttsModelOptions
    || localVoice !== voice
    || VOICE_CUSTOMIZATION_FIELDS.some(key => localCustomization[key] !== voiceCustomization[key])
    || localMaxSegmentLength !== ttsSegmentMaxBlockLength
    || JSON.stringify(localPdfSkipKinds) !== JSON.stringify(pdfSkipBlockKinds)
    || localSpeechText.citations !== speechText.citations || localSpeechText.brackets !== speechText.brackets
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
        ttsInstructions: savedInstructions,
        ttsModelOptions: savedModelOptions,
        speechText: localSpeechText,
        voiceCustomization: localCustomization,
        ttsSegmentMaxBlockLength: localMaxSegmentLength,
        pdfSkipBlockKinds: localPdfSkipKinds,
        ...(shownVoice ? { voice: shownVoice } : {}),
        ...(providerModelPolicy.supportsNativeModelSpeed ? { voiceSpeed: localSpeed } : {}),
      });
      // The displayed fallback voice becomes an explicit preference on Save.
      // Keep the draft aligned with that committed selection as well.
      if (shownVoice) setLocalVoice(shownVoice);
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
            <ProviderSelect
              aria-label="Provider"
              value={selectedProvider}
              options={viewModel.providers}
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
        {effectiveProviderType === 'openrouter' && <OpenRouterOptionsControls model={finalModel}
          modelName={catalog.data?.find(model => model.id === finalModel)?.name ?? finalModel}
          value={localModelOptions} providerDefault={selectedDefaults.modelOptions} error={modelOptions.error}
          onChange={setLocalModelOptions} />}
      </Section>

      {providerModelPolicy.supportsInstructions && (
        <Section title="Instructions" variant="group">
          <SettingRow
            label="Voice instructions"
            icon={<ChatBubbleIcon />}
            description={followsProviderInstructions ? 'Set by your provider. Edits apply only to you.' : undefined}
            stacked
          >
            <Textarea
              aria-label="Voice instructions"
              value={localInstructions}
              onChange={(event) => setLocalInstructions(event.target.value)}
              placeholder="Optional voice instructions"
              className="h-24 resize-none"
            />
            {selectedDefaults.instructions && !followsProviderInstructions && (
              <div className="flex justify-end">
                <Button size="xs" variant="ghost" onClick={() => setLocalInstructions(selectedDefaults.instructions)}>
                  Use provider default
                </Button>
              </div>
            )}
          </SettingRow>
        </Section>
      )}

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
              max={effectiveProviderType === 'fish-audio' || effectiveProviderType === 'openrouter' ? 2 : MODEL_SPEED_MAX}
              step={0.1}
              value={localSpeed}
              onChange={(event) => setLocalSpeed(Number(Number(event.target.value).toFixed(2)))}
            />
          </div>
        )}

        {effectiveProviderType === 'fish-audio' && (
          <p className="text-xs text-soft">{shownVoice === 'default'
            ? 'Your saved default lets Fish choose a voice for each request. Select a named voice and Save to keep narration consistent.'
            : 'Named voices keep the same voice reference across narration segments. Custom voice IDs are also supported.'}</p>
        )}
        {voicesPending ? (
          <p className="text-xs text-soft">Loading voices…</p>
        ) : (
          <VoicePicker
            cloning={{ providerRef: viewModel.selectedProviderRef, providerType: effectiveProviderType, model: finalModel }}
            key={`${viewModel.selectedProviderRef}:${finalModel}`}
            allowCustomVoice={providerModelPolicy.isResolvedProviderType && providerModelPolicy.providerType !== 'kokoro-local'}
            favorites={favorites}
            voices={voiceOptions}
            value={shownVoice}
            onChange={setLocalVoice}
            pickPolicy={voicePickPolicy}
            groupByLanguage={providerModelPolicy.isKokoroModel}
            preview={pickerPreview}
          />
        )}
      </Section>

      <Section title="Skip when reading aloud" variant="group" footer="Each book can override these from its Voice panel.">
        <SpeechTextControls value={localSpeechText} onChange={change => setLocalSpeechText({ ...localSpeechText, ...change })} />
        <PdfBlockKindControls value={localPdfSkipKinds} onChange={setLocalPdfSkipKinds} />
      </Section>

      <AdvancedSettings>
        <VoiceCustomizationControls value={localCustomization} local={effectiveProviderType === 'kokoro-local'}
          onChange={change => setLocalCustomization({ ...localCustomization, ...change })} />
        <MaxSegmentLengthControl value={localMaxSegmentLength} onChange={setLocalMaxSegmentLength} />
      </AdvancedSettings>

      {dirty || saving ? (
        <SaveBar
          saving={saving}
          saveDisabled={!viewModel.canSubmit || sharedProvidersLoading || !!modelOptions.error}
          onDiscard={discard}
          onSave={() => void save()}
        />
      ) : null}
    </div>
  );
}

/** Options are bound to the OpenRouter model they were written for. */
function readModelOptions(providerType: string, value: string, model: string): { normalized: string; error?: string } {
  if (providerType !== 'openrouter') return { normalized: '' };
  try { return { normalized: normalizeOpenRouterOptions(value, model) }; }
  catch (error) { return { normalized: '', error: (error as Error).message }; }
}
