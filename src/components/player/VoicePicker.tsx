'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClonedVoiceLibrary } from './ClonedVoiceLibrary';
import type { VoiceCloningContext } from './CloneVoiceEditor';
import { CheckIcon, DisclosureIcon, HeartIcon, PauseIcon, PlayIcon } from '@/components/icons/Icons';
import { AnimatedCollapse } from '@/components/settings/ExpandableSettingsCard';
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

/** Voices shown before the list fades out; the rest reveal in batches. */
const FIRST_VOICES = 8;
const VOICE_BATCH = 16;
/** Fewer hidden voices than this are simply shown rather than folded away. */
const MIN_FOLDED = 4;
/** Stagger between rows revealed together, capped so a batch lands quickly. */
const REVEAL_STAGGER_MS = 22;

/** The preview key for "the voice as currently picked", beside per-voice keys. */
export const SELECTION_PREVIEW_KEY = 'selection';

export interface VoicePickerPreview {
  state: VoicePreviewState;
  play: (key: string, voice: string) => void;
  stop: () => void;
}

/** Personal and preset voices share selection, favorites and preview controls. */
export function VoicePickerRow({ voice, name, note, selected, onSelect, preview, actions, favorites, onError }: {
  voice: string; name: string; note?: string; selected: boolean; onSelect: () => void;
  preview: VoicePickerPreview; actions?: ReactNode;
  favorites?: { voices: Set<string>; toggle: (voice: string) => Promise<void>; available: boolean };
  onError: (message: string) => void;
}) {
  return <div className={cn('flex items-center gap-2 rounded-md pl-1 pr-2', selected ? 'bg-accent-wash' : 'hover:bg-surface-sunken')}>
    <VoicePreviewButton previewKey={voice} label={name} preview={preview} voice={voice} />
    <button type="button" aria-label={name} aria-pressed={selected} onClick={onSelect}
      className={cn('flex min-w-0 flex-1 items-center justify-between gap-2 rounded py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', selected ? 'font-medium text-accent' : 'text-foreground')}>
      <span className="min-w-0"><span className="block truncate">{name}</span>{note && <span className="block text-xs text-soft">{note}</span>}</span>
      {selected && <CheckIcon className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
    </button>
    {favorites?.available && <IconButton size="sm" aria-pressed={favorites.voices.has(voice)}
      aria-label={favorites.voices.has(voice) ? `Remove ${name} from favorites` : `Favorite ${name}`}
      className={favorites.voices.has(voice) ? 'text-accent' : 'text-faint'} onClick={() => { onError(''); void favorites.toggle(voice).catch(() => onError('Could not save favorites. Please try again.')); }}>
      <HeartIcon className="h-4 w-4" fill={favorites.voices.has(voice) ? 'currentColor' : 'none'} />
    </IconButton>}
    {actions}
  </div>;
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
  const total = groups.reduce((sum, group) => sum + group.voices.length, 0);
  // Searching or filtering already narrows the list, so it shows in full.
  const foldable = !query.trim() && !favoritesOnly && total > FIRST_VOICES + MIN_FOLDED;
  const [limit, setLimit] = useState(FIRST_VOICES);
  // Rows from this index rise in; earlier rows were already on screen.
  const [revealFrom, setRevealFrom] = useState(Infinity);
  // After the first "Show more", reaching the fade reveals the next batch.
  const [endless, setEndless] = useState(false);
  const shownLimit = foldable ? limit : Infinity;
  // Only a folding list animates its height; search and favorites resize at once.
  const fold = (list: ReactNode) => foldable ? <AnimatedCollapse open>{list}</AnimatedCollapse> : list;
  // Selected voices always stay in view, wherever they fall in the list.
  let order = 0;
  const shownGroups = groups.map((group) => ({
    ...group,
    rows: group.voices.map((voiceId) => ({ voiceId, index: order++ }))
      .filter(({ voiceId, index }) => index < shownLimit || selectedVoices.includes(voiceId)),
  })).filter((group) => group.rows.length > 0);
  const hidden = total - shownGroups.reduce((sum, group) => sum + group.rows.length, 0);
  const listTop = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const revealMore = () => {
    setRevealFrom(limit);
    setLimit(current => Math.min(total, current + VOICE_BATCH));
  };
  const revealMoreRef = useRef(revealMore);
  revealMoreRef.current = revealMore;
  useEffect(() => {
    const element = sentinel.current;
    if (!endless || !hidden || !element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) revealMoreRef.current();
    }, { rootMargin: '0px 0px 160px 0px' });
    // Wait for the last batch to finish growing, or the fade would still be
    // in view and every batch would load at once.
    const settle = window.setTimeout(() => observer.observe(element), 360);
    return () => { window.clearTimeout(settle); observer.disconnect(); };
  }, [endless, hidden, limit]);
  const showFewer = () => {
    setEndless(false);
    setRevealFrom(Infinity);
    setLimit(FIRST_VOICES);
    listTop.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
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
      {cloning?.providerRef && ['fish-audio', 'openrouter'].includes(cloning.providerType) && <h4 className="pt-2 text-sm font-semibold text-soft">Built-in voices</h4>}
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
        <div ref={listTop} className="relative scroll-mt-4">
          {fold(
            <div className={cn('space-y-3 pt-1', hidden > 0 && '[mask-image:linear-gradient(to_bottom,black_calc(100%-6rem),transparent)]')}>
              {shownGroups.map(({ rows, ...group }) => {
                return (
                  <div key={group.key} role="group" aria-label={group.label}>
                    {shownGroups.length > 1 || groupByLanguage ? (
                      <h4 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                        {group.label}
                      </h4>
                    ) : null}
                    <ul className="space-y-0.5">
                      {rows.map(({ voiceId, index }) => {
                        const selected = selectedVoices.includes(voiceId);
                        const name = displayVoiceName(voiceId);
                        const rising = index >= revealFrom;
                        return (
                          <li key={voiceId} className={rising ? 'animate-rise-in motion-reduce:animate-none' : undefined}
                            style={rising ? { animationDelay: `${Math.min(index - revealFrom, VOICE_BATCH) * REVEAL_STAGGER_MS}ms` } : undefined}>
                            <VoicePickerRow voice={voiceId} name={name} selected={selected} onSelect={() => pick(voiceId)}
                              preview={preview} favorites={groupByLanguage && voiceId.includes('+') ? undefined : favorites} onError={setFavoriteError} />
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
          {hidden > 0 ? (
            <div ref={sentinel} className="pointer-events-none absolute inset-x-0 bottom-0 flex h-24 items-end justify-center pb-2">
              <button type="button" onClick={() => { setEndless(true); revealMore(); }}
                className="group pointer-events-auto inline-flex animate-scale-in items-center gap-2 rounded-full border border-line-soft bg-[color-mix(in_srgb,var(--surface-solid),transparent_22%)] py-1.5 pl-3.5 pr-3 text-xs font-medium text-foreground shadow-[0_6px_24px_-8px_color-mix(in_srgb,var(--accent),transparent_55%)] backdrop-blur-md transition duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-0.5 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:translate-y-0 active:scale-[0.97] motion-reduce:animate-none motion-reduce:transition-none">
                <span className="tabular-nums">{endless ? `${hidden} more` : `Show ${hidden} more`}</span>
                <span className="animate-nudge-down text-accent motion-reduce:animate-none" aria-hidden>
                  <DisclosureIcon className="h-3.5 w-3.5 rotate-90" />
                </span>
              </button>
            </div>
          ) : foldable && limit > FIRST_VOICES ? (
            <div className="flex justify-center pt-2">
              <button type="button" onClick={showFewer}
                className="inline-flex animate-fade-in items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-soft transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:animate-none">
                Show fewer
                <DisclosureIcon className="h-3.5 w-3.5 -rotate-90" aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
      )}
      {showCustomVoice && (
        <details
          className="group rounded-lg border border-line-soft bg-surface-solid"
          open={customVoiceOpen}
          onToggle={(event) => setCustomVoiceOpen(event.currentTarget.open)}
        >
          {/* Reset on the opening click: the toggle event fires a task later and would overwrite typing. */}
          <summary onClick={() => { if (!customVoiceOpen) setCustomVoice(value); }} className="cursor-pointer select-none rounded-lg px-3 py-2 text-sm font-medium text-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
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
