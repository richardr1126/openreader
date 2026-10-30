'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { normalizeVoiceCustomization } from '@openreader/tts/voice-customization';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS, useTTSHighlight } from '@/contexts/TTSContext';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { BookIcon } from '@/components/icons/Icons';
import { Button, RangeField, Section } from '@/components/ui';
import { SELECTION_PREVIEW_KEY, VoicePicker, VoicePreviewButton, type VoicePickerPreview } from '@/components/player/VoicePicker';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { useVoicePreview } from '@/hooks/audio/useVoicePreview';
import { getTtsLanguageCompatibilityWarnings, resolveTtsLanguage } from '@openreader/tts/language';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import {
  describePendingVoiceChanges,
  formatModelSpeed,
  pendingVoiceSettings,
  type VoicePickPolicy,
  type VoiceSettingsDraft,
} from '@/lib/client/tts/voice-draft';
import { buildVoicePreviewText } from '@/lib/shared/tts-voice-preview';
import { useVoiceFavorites } from '@/hooks/useVoiceFavorites';
import { useClonedVoiceNames } from '@/hooks/useClonedVoiceNames';
import { BookSkipSettings } from '@/components/settings/BookSkipSettings';

/**
 * The reader's voice panel. Voice and model-speed picks are a draft: they
 * regenerate audio, so nothing changes until Apply commits them in one
 * restart. Closing the panel discards the draft. Previews speak a short
 * sample with the draft settings and never touch the document's audio.
 * What the book skips sits below the voices and applies on its own, after
 * the regenerate confirmation.
 */
export function VoiceSidebar({ isOpen, onClose, pdf = false }: { isOpen: boolean; onClose: () => void; pdf?: boolean }) {
  const { providerRef, providerType, ttsModel, ttsInstructions, ttsModelOptions, voiceCustomization } = useConfig();
  const favorites = useVoiceFavorites(providerRef, ttsModel);
  const {
    voice: appliedVoice,
    voiceSpeed,
    ownVoice,
    ownVoiceSpeed,
    availableVoices,
    documentLanguage,
    detectedDocumentLanguage,
    isPlaying,
    isProcessing,
    pause,
    setBookVoiceAndRestart,
    bookSpeechSettings,
  } = useTTS();
  const { currentSentence } = useTTSHighlight();
  const { providers } = useSharedProviders();
  const policy = useMemo(
    () => resolveTtsProviderModelPolicy({ providerRef, providerType, model: ttsModel }),
    [providerRef, providerType, ttsModel],
  );
  const pickPolicy: VoicePickPolicy = useMemo(() => ({
    multi: policy.isKokoroModel && policy.maxVoices > 1,
    maxVoices: policy.maxVoices,
  }), [policy.isKokoroModel, policy.maxVoices]);

  const applied: VoiceSettingsDraft = useMemo(() => ({
    voice: appliedVoice || '',
    nativeSpeed: policy.supportsNativeModelSpeed ? voiceSpeed : 1,
  }), [appliedVoice, policy.supportsNativeModelSpeed, voiceSpeed]);
  // Only explicit picks are stored; an untouched field follows the applied value.
  const [edits, setEdits] = useState<Partial<VoiceSettingsDraft>>({});
  const draft: VoiceSettingsDraft = { ...applied, ...edits };
  const pending = pendingVoiceSettings(applied, draft);
  const clonedNames = useClonedVoiceNames(applied.voice, draft.voice);
  const pendingLines = describePendingVoiceChanges(applied, draft, clonedNames);

  const preview = useVoicePreview({ isPlaying, pausePlayback: pause });
  const { stop: stopPreview } = preview;

  const close = useCallback(() => {
    stopPreview();
    setEdits({});
    onClose();
  }, [onClose, stopPreview]);

  useEffect(() => {
    if (!isOpen) {
      stopPreview();
      setEdits({});
    }
  }, [isOpen, stopPreview]);

  const languageWarnings = getTtsLanguageCompatibilityWarnings({
    model: ttsModel,
    providerType: policy.providerType,
    voice: draft.voice,
    configuredLanguage: documentLanguage,
    documentLanguage: detectedDocumentLanguage,
  });
  const providerName = providers.find((entry) => entry.slug === providerRef)?.displayName || providerRef;

  const playPreview = useCallback((key: string, voice: string) => {
    void preview.play(key, {
      settings: {
        providerRef,
        providerType,
        ttsModel,
        ...(providerType === 'openrouter' && ttsModelOptions ? { ttsModelOptions } : {}),
        voice,
        nativeSpeed: draft.nativeSpeed,
        voiceCustomization: normalizeVoiceCustomization({ ...voiceCustomization, ...bookSpeechSettings.voiceCustomization }),
        ...(policy.supportsInstructions && ttsInstructions ? { ttsInstructions } : {}),
        language: resolveTtsLanguage({ configuredLanguage: documentLanguage, documentLanguage: detectedDocumentLanguage, voice }),
      },
      text: buildVoicePreviewText({ currentSentence, documentLanguage: documentLanguage === 'auto' ? detectedDocumentLanguage : documentLanguage, voice }),
    });
  }, [
    currentSentence,
    documentLanguage,
    detectedDocumentLanguage,
    draft.nativeSpeed,
    policy.supportsInstructions,
    preview,
    providerRef,
    providerType,
    ttsInstructions,
    ttsModelOptions,
    ttsModel,
    voiceCustomization,
    bookSpeechSettings.voiceCustomization,
  ]);

  const pickerPreview: VoicePickerPreview = { state: preview.state, play: playPreview, stop: stopPreview };

  const apply = () => {
    if (!pending) return;
    stopPreview();
    setBookVoiceAndRestart(pending);
    setEdits({});
  };

  const footer = pending ? (
    <div className="border-t border-line-soft bg-surface-solid px-4 py-3" role="region" aria-label="Pending voice changes">
      <ul className="mb-2.5 space-y-0.5 text-xs text-soft">
        {pendingLines.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p className="mb-2.5 text-[11px] text-faint">Applying regenerates audio from the current position.</p>
      <div className="flex gap-2">
        <Button variant="secondary" size="md" className="flex-1" onClick={() => setEdits({})}>
          Discard
        </Button>
        <Button variant="primary" size="md" className="flex-1" onClick={apply} disabled={isProcessing}>
          Apply
        </Button>
      </div>
    </div>
  ) : null;

  return (
    <ReaderSidebarShell
      isOpen={isOpen}
      onClose={close}
      ariaLabel="Voice"
      title="Voice"
      subtitle={`${providerName} · ${ttsModel}`}
      footer={footer}
      bodyClassName="flex-1 overflow-y-auto px-4 py-4 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--accent),transparent_92%),transparent_35%)]"
      panelClassName="w-full sm:w-[24rem]"
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3 rounded-xl border border-line-soft bg-surface-solid px-3 py-2.5">
          <BookIcon className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <p className="min-w-0 flex-1 text-xs text-soft">
            {ownVoice || ownVoiceSpeed
              ? 'This book has its own voice settings.'
              : 'Changes here apply to this book only.'}
          </p>
          {(ownVoice || ownVoiceSpeed) && (
            <Button
              variant="secondary"
              size="sm"
              disabled={isProcessing}
              onClick={() => {
                stopPreview();
                setEdits({});
                setBookVoiceAndRestart({ voice: null, nativeSpeed: null });
              }}
            >
              Use default
            </Button>
          )}
        </div>
        {policy.supportsNativeModelSpeed && (
          <Section title="Model speed" variant="group">
            <RangeField
              label="Model speed"
              value={draft.nativeSpeed}
              min={0.5}
              max={policy.providerType === 'fish-audio' || policy.providerType === 'openrouter' ? 2 : 3}
              step={0.1}
              formatter={formatModelSpeed}
              description="Changes how fast the voice speaks and regenerates audio. Playback speed in the player applies instantly."
              onChange={(value) => setEdits((current) => ({ ...current, nativeSpeed: Number(value.toFixed(2)) }))}
            />
          </Section>
        )}

        <Section
          title="Voices"
          variant="group"
          subtitle={pickPolicy.multi && Number.isFinite(pickPolicy.maxVoices)
            ? `Select up to ${pickPolicy.maxVoices} voices to blend them.`
            : pickPolicy.multi ? 'Select several voices to blend them.' : undefined}
          action={availableVoices.length > 0 ? (
            <span className="flex items-center gap-1.5">
              <span>Preview selection</span>
              <VoicePreviewButton
                previewKey={SELECTION_PREVIEW_KEY}
                label="selection"
                preview={pickerPreview}
                disabled={!draft.voice}
                voice={draft.voice}
              />
            </span>
          ) : undefined}
        >
          {/* Remounting on open starts each visit with an empty search. */}
          <VoicePicker
            cloning={{ providerRef, providerType, model: ttsModel, beforeCapture: pause }}
            allowCustomVoice={policy.isResolvedProviderType && policy.providerType !== 'kokoro-local'}
            favorites={favorites}
            key={isOpen ? 'open' : 'closed'}
            voices={availableVoices}
            value={draft.voice}
            onChange={(voice) => setEdits((current) => ({ ...current, voice }))}
            pickPolicy={pickPolicy}
            groupByLanguage={policy.isKokoroModel}
            preview={pickerPreview}
            notices={<>
              {policy.providerType === 'fish-audio' && draft.voice === 'default' && (
                <p className="text-xs text-warning">Select a named voice and Apply to keep narration consistent across passages.</p>
              )}
              {languageWarnings.map((warning) => (
                <p key={warning} className="text-xs text-warning">{warning}</p>
              ))}
            </>}
          />
        </Section>

        <BookSkipSettings pdf={pdf} />
      </div>
    </ReaderSidebarShell>
  );
}
