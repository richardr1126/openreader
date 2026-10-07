'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS, useTTSHighlight } from '@/contexts/TTSContext';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { CheckIcon, PauseIcon, PlayIcon } from '@/components/icons/Icons';
import { LoadingSpinner } from '@/components/Spinner';
import { Button, IconButton, Input, RangeField, Section, cn } from '@/components/ui';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { useVoicePreview, type VoicePreviewState } from '@/hooks/audio/useVoicePreview';
import { getTtsLanguageCompatibilityWarnings, resolveTtsLanguage } from '@openreader/tts/language';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import {
  describePendingVoiceChanges,
  formatModelSpeed,
  groupVoices,
  pendingVoiceSettings,
  selectedVoicesFor,
  toggleDraftVoice,
  voiceStringFor,
  type VoicePickPolicy,
  type VoiceSettingsDraft,
} from '@/lib/client/tts/voice-draft';
import { buildVoicePreviewText } from '@/lib/shared/tts-voice-preview';

const DRAFT_PREVIEW_KEY = 'draft';

function PreviewButton({ previewKey, label, state, disabled, onPlay, onStop }: {
  previewKey: string;
  label: string;
  state: VoicePreviewState;
  disabled?: boolean;
  onPlay: () => void;
  onStop: () => void;
}) {
  const active = state.phase !== 'idle' && state.phase !== 'error' && state.key === previewKey;
  return (
    <IconButton
      onClick={active ? onStop : onPlay}
      disabled={disabled}
      aria-label={active ? `Stop preview of ${label}` : `Preview ${label}`}
      aria-busy={active && state.phase === 'loading'}
      tone="surface"
      className="h-7 w-7 shrink-0 rounded-full text-soft hover:text-accent"
    >
      {active && state.phase === 'loading'
        ? <LoadingSpinner />
        : active
          ? <PauseIcon className="h-3.5 w-3.5" />
          : <PlayIcon className="h-3.5 w-3.5" />}
    </IconButton>
  );
}

/**
 * The reader's voice panel. Voice and model-speed picks are a draft: they
 * regenerate audio, so nothing changes until Apply commits them in one
 * restart. Closing the panel discards the draft. Previews speak a short
 * sample with the draft settings and never touch the document's audio.
 */
export function VoiceSidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { providerRef, providerType, ttsModel, ttsInstructions, voiceSpeed } = useConfig();
  const {
    voice: appliedVoice,
    availableVoices,
    documentLanguage,
    resolvedLanguage,
    isPlaying,
    isProcessing,
    pause,
    setVoiceSettingsAndRestart,
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
  const pendingLines = describePendingVoiceChanges(applied, draft);
  const [query, setQuery] = useState('');

  const preview = useVoicePreview({ isPlaying, pausePlayback: pause });
  const { stop: stopPreview } = preview;

  const close = useCallback(() => {
    stopPreview();
    setEdits({});
    setQuery('');
    onClose();
  }, [onClose, stopPreview]);

  useEffect(() => {
    if (!isOpen) {
      stopPreview();
      setEdits({});
      setQuery('');
    }
  }, [isOpen, stopPreview]);

  const selectedVoices = selectedVoicesFor(draft.voice, availableVoices, pickPolicy);
  const groups = useMemo(
    () => groupVoices(availableVoices, query, policy.isKokoroModel),
    [availableVoices, policy.isKokoroModel, query],
  );
  const languageWarnings = getTtsLanguageCompatibilityWarnings({
    model: ttsModel,
    voice: draft.voice,
    documentLanguage: resolvedLanguage,
  });
  const providerName = providers.find((entry) => entry.slug === providerRef)?.displayName || providerRef;

  const playPreview = useCallback((key: string, voice: string) => {
    void preview.play(key, {
      settings: {
        providerRef,
        providerType,
        ttsModel,
        voice,
        nativeSpeed: draft.nativeSpeed,
        ...(policy.supportsInstructions && ttsInstructions ? { ttsInstructions } : {}),
        language: resolveTtsLanguage({ configuredLanguage: documentLanguage, voice }),
      },
      text: buildVoicePreviewText({ currentSentence, documentLanguage, voice }),
    });
  }, [
    currentSentence,
    documentLanguage,
    draft.nativeSpeed,
    policy.supportsInstructions,
    preview,
    providerRef,
    providerType,
    ttsInstructions,
    ttsModel,
  ]);

  const pickVoice = (voiceId: string) => {
    const next = voiceStringFor(toggleDraftVoice(selectedVoices, voiceId, pickPolicy), pickPolicy);
    if (next) setEdits((current) => ({ ...current, voice: next }));
  };

  const apply = () => {
    if (!pending) return;
    stopPreview();
    setVoiceSettingsAndRestart(pending);
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

  const previewError = preview.state.phase === 'error' ? preview.state : null;

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
        {policy.supportsNativeModelSpeed && (
          <Section title="Model speed" variant="group">
            <RangeField
              label="Model speed"
              value={draft.nativeSpeed}
              min={0.5}
              max={3}
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
              <PreviewButton
                previewKey={DRAFT_PREVIEW_KEY}
                label="selection"
                state={preview.state}
                disabled={!draft.voice}
                onPlay={() => playPreview(DRAFT_PREVIEW_KEY, draft.voice)}
                onStop={stopPreview}
              />
            </span>
          ) : undefined}
        >
          <div className="space-y-2">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={policy.isKokoroModel ? 'Search voices or languages' : 'Search voices'}
              aria-label="Search voices"
              controlSize="sm"
            />
            {languageWarnings.map((warning) => (
              <p key={warning} className="text-xs text-warning">{warning}</p>
            ))}
            {previewError && (
              <p role="status" className="text-xs text-warning">{previewError.message}</p>
            )}
            {availableVoices.length === 0 ? (
              <p className="py-2 text-sm text-soft">No voices are available for this model.</p>
            ) : groups.length === 0 ? (
              <p className="py-2 text-sm text-soft">No voices match “{query.trim()}”.</p>
            ) : (
              <div className="space-y-3 pt-1">
                {groups.map((group) => (
                  <div key={group.key} role="group" aria-label={group.label}>
                    {groups.length > 1 || policy.isKokoroModel ? (
                      <h4 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                        {group.label}
                      </h4>
                    ) : null}
                    <ul className="space-y-0.5">
                      {group.voices.map((voiceId) => {
                        const selected = selectedVoices.includes(voiceId);
                        return (
                          <li
                            key={voiceId}
                            className={cn(
                              'flex items-center gap-2 rounded-md pl-1 pr-2',
                              selected ? 'bg-accent-wash' : 'hover:bg-surface-sunken',
                            )}
                          >
                            <PreviewButton
                              previewKey={voiceId}
                              label={voiceId}
                              state={preview.state}
                              onPlay={() => playPreview(voiceId, voiceId)}
                              onStop={stopPreview}
                            />
                            <button
                              type="button"
                              aria-pressed={selected}
                              onClick={() => pickVoice(voiceId)}
                              className={cn(
                                'flex min-w-0 flex-1 items-center justify-between gap-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded',
                                selected ? 'font-medium text-accent' : 'text-foreground',
                              )}
                            >
                              <span className="truncate">{voiceId}</span>
                              {selected ? <CheckIcon className="h-4 w-4 shrink-0" aria-hidden /> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>
      </div>
    </ReaderSidebarShell>
  );
}
