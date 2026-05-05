'use client';

import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popover, PopoverButton, PopoverPanel, Transition } from '@headlessui/react';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { RefreshIcon, InfoIcon } from '@/components/icons/Icons';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import type {
  TTSSegmentLocator,
  TTSSegmentRow,
  TTSSegmentSettings,
  TTSSegmentVariant,
  TTSSegmentsManifestResponse,
} from '@/types/client';

interface SegmentsSidebarProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  documentId: string;
}

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: TTSSegmentRow[]; fetchedAt: number }
  | { kind: 'error'; message: string };

function formatDuration(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '—';
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function formatIndex(i: number): string {
  return String(i + 1).padStart(3, '0');
}

function formatVoiceLabel(settings: TTSSegmentSettings | null): string {
  if (!settings) return 'Unknown voice';
  const voice = settings.voice?.trim() || '';
  if (!voice) return 'Unknown voice';

  const voices = voice
    .split('+')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => name.replace(/\([^)]*\)/g, '').trim())
    .filter(Boolean);

  const baseLabel = voices.length > 0 ? voices.join(' + ') : voice;
  const speed = Number(settings.nativeSpeed);
  const speedSuffix = Number.isFinite(speed) && speed !== 1 ? ` (${speed}x)` : '';

  return `${baseLabel}${speedSuffix}`;
}

function settingsAreEqual(a: TTSSegmentSettings | null, b: TTSSegmentSettings | null): boolean {
  if (!a || !b) return false;
  return (
    a.ttsProvider === b.ttsProvider
    && a.ttsModel === b.ttsModel
    && a.voice === b.voice
    && Number(a.nativeSpeed) === Number(b.nativeSpeed)
    && (a.ttsInstructions || '') === (b.ttsInstructions || '')
  );
}

function statusColor(status: TTSSegmentVariant['status']): string {
  if (status === 'completed') return 'bg-accent';
  if (status === 'error') return 'bg-red-500';
  return 'bg-muted';
}

function locatorMatchesCurrent(
  locator: TTSSegmentLocator | null,
  currentLocation: string | number,
  currentPageNumber: number,
): boolean {
  if (!locator) return false;
  if (typeof locator.location === 'string' && locator.location.length > 0) {
    return String(locator.location) === String(currentLocation);
  }
  if (typeof locator.page === 'number' && Number.isFinite(locator.page)) {
    return Math.floor(locator.page) === Math.floor(Number(currentPageNumber || 1));
  }
  return false;
}

function latestUpdatedAt(row: TTSSegmentRow): number {
  return row.variants.reduce((max, variant) => {
    const updated = typeof variant.updatedAt === 'number' ? variant.updatedAt : 0;
    return Math.max(max, updated);
  }, 0);
}

export function SegmentsSidebar({ isOpen, setIsOpen, documentId }: SegmentsSidebarProps) {
  const {
    sentences,
    currentSentenceIndex,
    currDocPage,
    currDocPageNumber,
    isPlaying,
    stopAndPlayFromIndex,
  } = useTTS();
  const { ttsProvider, ttsModel, voice, voiceSpeed, ttsInstructions, updateConfigKey } = useConfig();

  const [state, setState] = useState<FetchState>({ kind: 'idle' });
  const [isClearing, setIsClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeSettings = useMemo<TTSSegmentSettings>(() => ({
    ttsProvider,
    ttsModel,
    voice,
    nativeSpeed: Number.isFinite(Number(voiceSpeed)) ? Number(voiceSpeed) : 1,
    ttsInstructions: ttsInstructions || '',
  }), [ttsProvider, ttsModel, voice, voiceSpeed, ttsInstructions]);

  const loadManifest = useCallback(async () => {
    if (!documentId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: 'loading' });
    try {
      const res = await fetch(
        `/api/tts/segments/manifest?documentId=${encodeURIComponent(documentId)}`,
        { signal: controller.signal, cache: 'no-store' },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as TTSSegmentsManifestResponse;
      setState({ kind: 'ready', data: data.segments, fetchedAt: Date.now() });
    } catch (err) {
      if (controller.signal.aborted) return;
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load' });
    }
  }, [documentId]);

  const handleClearCache = useCallback(async () => {
    if (!documentId || isClearing) return;
    const confirmed = window.confirm('Clear cached segments for this document? This removes generated audio and metadata for listed segments.');
    if (!confirmed) return;

    setIsClearing(true);
    setClearError(null);
    try {
      const res = await fetch('/api/tts/segments/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `Request failed (${res.status})`);
      }
      await loadManifest();
    } catch (error) {
      setClearError(error instanceof Error ? error.message : 'Failed to clear segments cache');
    } finally {
      setIsClearing(false);
    }
  }, [documentId, isClearing, loadManifest]);

  useEffect(() => {
    if (!isOpen) return;
    void loadManifest();
    return () => {
      abortRef.current?.abort();
    };
  }, [isOpen, loadManifest]);

  const handleSelectVariant = useCallback(async (settings: TTSSegmentSettings | null) => {
    if (!settings) return;
    await Promise.all([
      updateConfigKey('ttsProvider', settings.ttsProvider),
      updateConfigKey('ttsModel', settings.ttsModel),
      updateConfigKey('voice', settings.voice),
      updateConfigKey('voiceSpeed', Number.isFinite(Number(settings.nativeSpeed)) ? Number(settings.nativeSpeed) : 1),
      updateConfigKey('ttsInstructions', settings.ttsInstructions || ''),
    ]);
  }, [updateConfigKey]);

  const handleJump = useCallback((index: number) => {
    stopAndPlayFromIndex(index);
  }, [stopAndPlayFromIndex]);

  const segmentsByIndex = useMemo(() => {
    if (state.kind !== 'ready') return new Map<number, TTSSegmentRow>();
    const map = new Map<number, { row: TTSSegmentRow; score: number; updatedAt: number }>();
    for (const row of state.data) {
      const isCurrent = locatorMatchesCurrent(row.locator, currDocPage, currDocPageNumber);
      const score = isCurrent ? 2 : row.locator ? 0 : 1;
      if (score === 0) continue;

      const candidateUpdatedAt = latestUpdatedAt(row);
      const existing = map.get(row.segmentIndex);
      if (!existing) {
        map.set(row.segmentIndex, { row, score, updatedAt: candidateUpdatedAt });
        continue;
      }

      if (score > existing.score || (score === existing.score && candidateUpdatedAt >= existing.updatedAt)) {
        map.set(row.segmentIndex, { row, score, updatedAt: candidateUpdatedAt });
      }
    }

    const selected = new Map<number, TTSSegmentRow>();
    for (const [idx, entry] of map) selected.set(idx, entry.row);
    return selected;
  }, [state, currDocPage, currDocPageNumber]);

  const indicesToRender = useMemo(() => {
    const indices = new Set<number>();
    for (let i = 0; i < sentences.length; i += 1) indices.add(i);
    if (state.kind === 'ready') {
      for (const row of state.data) {
        if (Number.isInteger(row.segmentIndex) && row.segmentIndex >= 0) {
          indices.add(row.segmentIndex);
        }
      }
    }
    return Array.from(indices).sort((a, b) => a - b);
  }, [sentences, state]);

  const rowsToRender: Array<{ segmentIndex: number; sentenceText: string; row: TTSSegmentRow | null }> = [];
  for (const i of indicesToRender) {
    rowsToRender.push({
      segmentIndex: i,
      sentenceText: sentences[i] ?? '',
      row: segmentsByIndex.get(i) ?? null,
    });
  }

  const totalVariants = state.kind === 'ready'
    ? state.data.reduce((sum, r) => sum + r.variants.length, 0)
    : 0;

  const headerActions = (
    <>
      <button
        type="button"
        onClick={() => void handleClearCache()}
        aria-label="Clear segments cache"
        title="Clear cache for listed segments"
        disabled={isClearing}
        className="inline-flex items-center justify-center h-8 px-2 rounded-lg border border-offbase bg-base text-xs text-muted hover:bg-offbase hover:text-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isClearing ? 'Clearing…' : 'Clear'}
      </button>
      <button
        type="button"
        onClick={() => void loadManifest()}
        aria-label="Refresh segments"
        title="Refresh"
        className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-offbase bg-base text-muted hover:bg-offbase hover:text-accent transition-colors"
      >
        <RefreshIcon className="w-3.5 h-3.5" />
      </button>
    </>
  );

  const footer = (
    <div className="border-t border-offbase px-4 py-2">
      <p className="text-xs text-muted leading-relaxed">
        Click an index or sentence to jump. Click a voice label to switch the active voice.
      </p>
      {clearError && (
        <p className="mt-1 text-xs text-red-500">
          {clearError}
        </p>
      )}
    </div>
  );

  return (
    <ReaderSidebarShell
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      ariaLabel="TTS segments"
      title="Segments"
      headerActions={headerActions}
      footer={footer}
      bodyClassName="flex-1 overflow-y-auto px-0 py-0"
    >
      <div className="px-4 py-2 border-b border-offbase">
        <div className="text-xs text-muted">
          {state.kind === 'ready' ? (
            <>
              {state.data.length} indexed
              <span> · </span>
              {totalVariants} variants
            </>
          ) : state.kind === 'loading' ? (
            <span>Loading…</span>
          ) : state.kind === 'error' ? (
            <span className="text-red-500">error</span>
          ) : (
            <span>—</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
              {state.kind === 'error' && (
                <div className="px-4 py-6 text-sm text-red-500">{state.message}</div>
              )}
              {state.kind === 'loading' && (
                <div className="px-4 py-6 text-sm text-muted">Loading segments…</div>
              )}
              {state.kind === 'ready' && rowsToRender.length === 0 && (
                <div className="px-4 py-10 flex flex-col items-center text-center gap-2">
                  <div className="text-sm font-medium text-muted">
                    No segments
                  </div>
                  <p className="text-sm text-muted leading-relaxed max-w-[24ch]">
                    Press play in the reader to generate audio segments.
                  </p>
                </div>
              )}
              {state.kind === 'ready' && rowsToRender.length > 0 && (
                <ul className="divide-y divide-offbase">
                  {rowsToRender.map(({ segmentIndex, sentenceText, row }) => {
                    const isCurrent = segmentIndex === currentSentenceIndex;
                    const variants = row?.variants ?? [];
                    const activeVariant = variants.find((v) => settingsAreEqual(v.settings, activeSettings))
                      ?? variants[0]
                      ?? null;
                    const status = activeVariant?.status ?? 'pending';
                    const canJump = sentenceText.length > 0;
                    const playable = !!(activeVariant && activeVariant.audioPresignUrl);
                    return (
                      <li
                        key={segmentIndex}
                        className={`relative px-4 py-3 ${isCurrent ? 'bg-offbase/40' : ''}`}
                      >
                        {isCurrent && (
                          <span className="absolute inset-y-2 left-0 w-0.5 bg-accent rounded-r" aria-hidden />
                        )}
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => { if (canJump) handleJump(segmentIndex); }}
                            disabled={!canJump}
                            className={`text-xs font-medium shrink-0 pt-0.5 ${canJump ? 'text-muted hover:text-accent' : 'text-muted/50 cursor-not-allowed'}`}
                            title={canJump ? (playable ? 'Play this segment' : 'Jump to this segment') : 'Text not loaded yet'}
                            aria-label={`Segment ${segmentIndex + 1}`}
                          >
                            {formatIndex(segmentIndex)}
                          </button>

                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => { if (canJump) handleJump(segmentIndex); }}
                              disabled={!canJump}
                              className={`block w-full text-left ${canJump ? '' : 'cursor-not-allowed'}`}
                            >
                              <p className={`text-sm leading-snug ${isCurrent ? 'text-foreground' : 'text-foreground/90'} line-clamp-2`}>
                                {sentenceText || (
                                  <span className="text-muted italic text-xs">
                                    [text not loaded — press play to fetch]
                                  </span>
                                )}
                              </p>
                            </button>

                            <div className="mt-1 flex items-center gap-2 flex-wrap">
                              <span
                                className={`inline-block w-1.5 h-1.5 rounded-full ${statusColor(status)}`}
                                aria-label={`Status ${status}`}
                                title={status}
                              />
                              <span className="text-xs text-muted">
                                {formatDuration(activeVariant?.durationMs)}
                              </span>
                              {isCurrent && isPlaying && (
                                <span className="text-xs text-accent font-medium">
                                  playing
                                </span>
                              )}
                              {!canJump && (
                                <span className="text-[10px] text-muted/80 border border-offbase rounded px-1 py-0.5">
                                  not loaded
                                </span>
                              )}

                              {variants.length > 0 && (
                                <span className="flex flex-wrap items-start gap-0.5 max-w-full">
                                  {variants.map((variant) => {
                                    const isActive = settingsAreEqual(variant.settings, activeSettings);
                                    const known = !!variant.settings;
                                    return (
                                      <button
                                        key={variant.segmentId}
                                        type="button"
                                        disabled={!known}
                                        onClick={() => void handleSelectVariant(variant.settings)}
                                        title={
                                          variant.settings
                                            ? `${variant.settings.ttsProvider} · ${variant.settings.ttsModel} · ${variant.settings.voice}${variant.settings.nativeSpeed && variant.settings.nativeSpeed !== 1 ? ` · ${variant.settings.nativeSpeed}×` : ''}`
                                            : 'Unknown variant'
                                        }
                                        className={[
                                          'max-w-full whitespace-normal break-words text-left leading-none text-[10px] px-1 py-0.5 rounded border transition-colors',
                                          isActive
                                            ? 'border-accent text-accent bg-offbase/60'
                                            : known
                                              ? 'border-offbase text-muted hover:border-accent hover:text-accent'
                                              : 'border-offbase text-muted opacity-60 cursor-not-allowed',
                                        ].join(' ')}
                                      >
                                        {formatVoiceLabel(variant.settings)}
                                      </button>
                                    );
                                  })}
                                </span>
                              )}
                            </div>
                          </div>

                          {row && (
                            <SegmentMetadataPopover row={row} />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
      </div>
    </ReaderSidebarShell>
  );
}

function SegmentMetadataPopover({ row }: { row: TTSSegmentRow }) {
  return (
    <Popover className="relative shrink-0">
      <PopoverButton
        aria-label="Segment metadata"
        title="Metadata"
        className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-transparent text-muted hover:bg-offbase hover:border-offbase hover:text-accent transition-colors"
      >
        <InfoIcon className="w-3.5 h-3.5" />
      </PopoverButton>
      <Transition
        as={Fragment}
        enter="transition ease-out duration-150"
        enterFrom="opacity-0 translate-y-1"
        enterTo="opacity-100 translate-y-0"
        leave="transition ease-in duration-100"
        leaveFrom="opacity-100 translate-y-0"
        leaveTo="opacity-0 translate-y-1"
      >
        <PopoverPanel
          anchor="bottom end"
          className="z-[60] w-[300px] mt-1 rounded-lg border border-offbase bg-base shadow-xl p-3"
        >
          <dl className="space-y-2">
            <Row label="locator">
              {row.locator ? (
                <span className="font-mono tabular-nums text-[11px] text-foreground break-all">
                  {row.locator.page !== undefined ? `p.${row.locator.page} ` : ''}
                  {row.locator.location ?? ''}
                  {row.locator.readerType ? ` (${row.locator.readerType})` : ''}
                </span>
              ) : (
                <span className="text-muted text-[11px]">none</span>
              )}
            </Row>
            <Row label="variants">
              <span className="font-mono tabular-nums text-[11px] text-foreground">
                {row.variants.length}
              </span>
            </Row>
            {row.variants.map((v) => (
              <div key={v.segmentId} className="border-t border-offbase pt-2">
                <Row label="segment_id">
                  <span className="font-mono text-[10px] text-muted break-all">
                    {v.segmentId.slice(0, 16)}…
                  </span>
                </Row>
                <Row label="settings">
                  <span className="font-mono text-[10px] text-foreground">
                    {v.settings
                      ? `${v.settings.ttsProvider} · ${v.settings.ttsModel} · ${formatVoiceLabel(v.settings)}`
                      : 'unknown'}
                  </span>
                </Row>
                <Row label="duration">
                  <span className="font-mono tabular-nums text-[10px] text-foreground">
                    {formatDuration(v.durationMs)}
                  </span>
                </Row>
                <Row label="status">
                  <span className="font-mono text-[10px] text-foreground">{v.status}</span>
                </Row>
                <Row label="alignment">
                  <span className="font-mono tabular-nums text-[10px] text-foreground">
                    {v.alignmentWordCount} words
                  </span>
                </Row>
              </div>
            ))}
          </dl>
        </PopoverPanel>
      </Transition>
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2 items-baseline">
      <dt className="font-mono uppercase tracking-[0.16em] text-[9px] text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
