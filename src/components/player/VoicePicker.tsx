'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ClonedVoiceLibrary } from './ClonedVoiceLibrary';
import type { VoiceCloningContext } from './CloneVoiceEditor';
import { CheckIcon, HeartIcon, PauseIcon, PlayIcon } from '@/components/icons/Icons';
import { LoadingSpinner } from '@/components/Spinner';
import { Button, IconButton, Input, cn } from '@/components/ui';
import type { VoicePreviewState } from '@/hooks/audio/useVoicePreview';
import {
  groupVoices,
  displayVoiceName,
  selectedVoicesFor,
  toggleDraftVoice,
  voiceStringFor,
  type VoicePickPolicy,
} from '@/lib/client/tts/voice-draft';

/** The preview key for "the voice as currently picked", beside per-voice keys. */
export const SELECTION_PREVIEW_KEY = 'selection';

export interface VoicePickerPreview {
  state: VoicePreviewState;
  play: (key: string, voice: string) => void;
  stop: () => void;
}

export function VoicePreviewButton({ previewKey, label, preview, disabled, voice }: {
  previewKey: string;
  label: string;
  preview: VoicePickerPreview;
  disabled?: boolean;
  voice: string;
}) {
  const { state } = preview;
  const active = state.phase !== 'idle' && state.phase !== 'error' && state.key === previewKey;
  return (
    <IconButton
      onClick={active ? preview.stop : () => preview.play(previewKey, voice)}
      disabled={disabled}
      aria-label={active ? `Stop preview of ${label}` : `Preview ${label}`}
      aria-busy={active && state.phase === 'loading'}
      tone="surface"
      className="h-7 w-7 shrink-0 rounded-full text-soft hover:text-accent"
    >
      {active && state.phase === 'loading'
        ? <LoadingSpinner className="h-3.5 w-3.5" />
        : active
          ? <PauseIcon className="h-3.5 w-3.5" />
          : <PlayIcon className="h-3.5 w-3.5" />}
    </IconButton>
  );
}

/**
 * The searchable voice list with a sample per voice. Kokoro voices group by
 * language and, where the provider allows, blend when several are picked.
 * The reader's voice panel and the default-voice setting share it.
 */
export function VoicePicker({
  voices,
  value,
  onChange,
  pickPolicy,
  groupByLanguage,
  preview,
  notices,
  favorites,
  allowCustomVoice = false,
  cloning,
}: {
  voices: string[];
  /** The voice string: one id, or a Kokoro blend. */
  value: string;
  onChange: (voice: string) => void;
  pickPolicy: VoicePickPolicy;
  groupByLanguage: boolean;
  preview: VoicePickerPreview;
  /** Warnings shown between the search field and the list. */
  notices?: ReactNode;
  favorites?: { voices: Set<string>; toggle: (voice: string) => Promise<void>; available: boolean };
  allowCustomVoice?: boolean;
  cloning?: VoiceCloningContext;
}) {
  const [query, setQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [customVoiceOpen, setCustomVoiceOpen] = useState(false);
  const [customVoice, setCustomVoice] = useState(value);
  const selectedVoices = selectedVoicesFor(value, voices, pickPolicy);
  const showCustomVoice = allowCustomVoice || selectedVoices.some((voice) => !voices.includes(voice));
  const customSelection = customVoice.trim()
    ? voiceStringFor(selectedVoicesFor(customVoice.trim(), [], pickPolicy), pickPolicy)
    : '';
  const groups = useMemo(() => groupVoices(
    (favoritesOnly ? voices.filter((voice) => favorites?.voices.has(voice)) : voices).filter(v => !v.startsWith('clone:')),
    query, groupByLanguage,
  ), [voices, query, groupByLanguage, favoritesOnly, favorites?.voices]);
  const previewError = preview.state.phase === 'error' ? preview.state : null;

  const pick = (voiceId: string) => {
    const next = voiceStringFor(toggleDraftVoice(selectedVoices, voiceId, pickPolicy), pickPolicy);
    if (next) onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2"><Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={groupByLanguage ? 'Search voices or languages' : 'Search voices'}
        aria-label="Search voices"
        controlSize="sm"
      />
      {favorites?.available && <Button size="sm" variant={favoritesOnly ? 'primary' : 'secondary'}
        aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>Favorites</Button>}
      </div>
      {favoriteError && <p role="alert" className="text-xs text-warning">{favoriteError}</p>}
      {notices}
      {cloning?.providerRef && ['fish-audio', 'openrouter'].includes(cloning.providerType) && <ClonedVoiceLibrary key={`${cloning.providerRef}:${cloning.model}`} cloning={cloning} value={value} onChange={onChange} preview={preview} favorites={favorites} query={query} favoritesOnly={favoritesOnly} fallbackVoice={voices.find(v => !v.startsWith('clone:')) ?? 'default'} />}
      {previewError && (
        <p role="status" className="text-xs text-warning">{previewError.message}</p>
      )}
      {voices.length === 0 ? (
        <p className="py-2 text-sm text-soft">No voices are available for this model.</p>
      ) : groups.length === 0 ? (
        <div className="space-y-2 py-2 text-sm text-soft">
          <p>{favoritesOnly && !query.trim() ? 'No favorite voices for this model.' : `No voices match “${query.trim()}”.`}</p>
          {favoritesOnly && <Button size="sm" onClick={() => setFavoritesOnly(false)}>Show all voices</Button>}
        </div>
      ) : (
        <div className="space-y-3 pt-1">
          {groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label}>
              {groups.length > 1 || groupByLanguage ? (
                <h4 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                  {group.label}
                </h4>
              ) : null}
              <ul className="space-y-0.5">
                {group.voices.map((voiceId) => {
                  const selected = selectedVoices.includes(voiceId);
                  const name = displayVoiceName(voiceId);
                  return (
                    <li
                      key={voiceId}
                      className={cn(
                        'flex items-center gap-2 rounded-md pl-1 pr-2',
                        selected ? 'bg-accent-wash' : 'hover:bg-surface-sunken',
                      )}
                    >
                      <VoicePreviewButton previewKey={voiceId} label={name} preview={preview} voice={voiceId} />
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => pick(voiceId)}
                        className={cn(
                          'flex min-w-0 flex-1 items-center justify-between gap-2 rounded py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                          selected ? 'font-medium text-accent' : 'text-foreground',
                        )}
                      >
                        <span className="truncate">{name}</span>
                        {selected ? <CheckIcon className="h-4 w-4 shrink-0" aria-hidden /> : null}
                      </button>
                      {favorites?.available && !(groupByLanguage && voiceId.includes('+')) && (
                        <IconButton size="sm" aria-pressed={favorites.voices.has(voiceId)}
                          aria-label={favorites.voices.has(voiceId) ? `Remove ${name} from favorites` : `Favorite ${name}`}
                          className={favorites.voices.has(voiceId) ? 'text-accent' : 'text-faint'}
                          onClick={() => {
                            setFavoriteError(null);
                            void favorites.toggle(voiceId).catch(() => setFavoriteError('Could not save favorites. Please try again.'));
                          }}>
                          <HeartIcon className="h-4 w-4" fill={favorites.voices.has(voiceId) ? 'currentColor' : 'none'} />
                        </IconButton>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {showCustomVoice && (
        <details
          className="group rounded-lg border border-line-soft bg-surface-solid"
          open={customVoiceOpen}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setCustomVoiceOpen(open);
            if (open) setCustomVoice(value);
          }}
        >
          <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-sm font-medium text-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            Custom voice ID
          </summary>
          <div className="flex items-center gap-2 border-t border-line-soft p-3">
            <Input
              className="min-w-0 flex-1"
              aria-label="Custom voice ID"
              placeholder="Voice ID from your provider"
              value={customVoice}
              onChange={(event) => setCustomVoice(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              controlSize="sm"
            />
            <VoicePreviewButton
              previewKey="custom-voice"
              label="custom voice"
              preview={preview}
              disabled={!customSelection}
              voice={customSelection}
            />
            <Button size="sm" className="shrink-0 whitespace-nowrap" disabled={!customSelection || customSelection === value} onClick={() => {
              preview.stop();
              onChange(customSelection);
            }}>
              Use voice
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}
