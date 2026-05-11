'use client';

import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popover, PopoverButton, PopoverPanel, Transition } from '@headlessui/react';
import toast from 'react-hot-toast';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { RefreshIcon, InfoIcon } from '@/components/icons/Icons';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { compareSegmentLocators, locatorGroupKey, normalizeEpubLocationToken } from '@/lib/shared/tts-locator';
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
  | {
    kind: 'ready';
    data: TTSSegmentRow[];
    fetchedAt: number;
    nextCursor: string | null;
    hasMore: boolean;
    loadingMore: boolean;
  }
  | { kind: 'error'; message: string };

const MANIFEST_PAGE_SIZE = 150;

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
    if (locator.readerType === 'epub') {
      if (typeof currentLocation !== 'string') return false;
      return normalizeEpubLocationToken(locator.location) === normalizeEpubLocationToken(currentLocation);
    }
    return String(locator.location) === String(currentLocation);
  }
  if (typeof locator.page === 'number' && Number.isFinite(locator.page)) {
    return Math.floor(locator.page) === Math.floor(Number(currentPageNumber || 1));
  }
  return false;
}

function formatLocatorGroupLabel(locator: TTSSegmentLocator | null): string {
  if (!locator) return 'Unknown location';
  const parts: string[] = [];
  if (typeof locator.page === 'number' && Number.isFinite(locator.page)) {
    parts.push(`Page ${Math.floor(locator.page)}`);
  }
  if (typeof locator.location === 'string' && locator.location) {
    parts.push(locator.location);
  }
  if (locator.readerType) {
    parts.push(locator.readerType.toUpperCase());
  }
  return parts.join(' · ') || 'Unknown location';
}

function compareRows(a: TTSSegmentRow, b: TTSSegmentRow): number {
  const byLocator = compareSegmentLocators(a.locator, b.locator);
  if (byLocator !== 0) return byLocator;
  if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
  return locatorGroupKey(a.locator).localeCompare(locatorGroupKey(b.locator));
}

function mergeRows(existing: TTSSegmentRow[], incoming: TTSSegmentRow[]): TTSSegmentRow[] {
  const map = new Map<string, TTSSegmentRow>();
  const upsert = (row: TTSSegmentRow) => {
    const key = `${row.segmentIndex}|${locatorGroupKey(row.locator)}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, row);
      return;
    }
    const bySegmentId = new Map<string, TTSSegmentVariant>();
    for (const variant of prev.variants) bySegmentId.set(variant.segmentId, variant);
    for (const variant of row.variants) bySegmentId.set(variant.segmentId, variant);
    map.set(key, {
      ...row,
      variants: Array.from(bySegmentId.values()),
    });
  };
  existing.forEach(upsert);
  incoming.forEach(upsert);
  return Array.from(map.values()).sort(compareRows);
}

function findScrollableAncestor(node: HTMLElement, fallback: HTMLElement | null): HTMLElement | null {
  let current: HTMLElement | null = node.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY.toLowerCase();
    const canScroll = (overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight + 1;
    if (canScroll) return current;
    current = current.parentElement;
  }
  return fallback;
}

function isElementFullyVisibleWithinContainer(element: HTMLElement, container: HTMLElement): boolean {
  const elRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return elRect.top >= containerRect.top && elRect.bottom <= containerRect.bottom;
}

export function SegmentsSidebar({ isOpen, setIsOpen, documentId }: SegmentsSidebarProps) {
  const {
    sentences,
    currentSentenceIndex,
    currDocPage,
    currDocPageNumber,
    isPlaying,
    playFromSegment,
  } = useTTS();
  const { ttsProvider, ttsModel, voice, voiceSpeed, ttsInstructions, updateConfigKey } = useConfig();

  const [state, setState] = useState<FetchState>({ kind: 'idle' });
  const [isClearing, setIsClearing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const didAutoScrollOnOpenRef = useRef(false);

  const activeSettings = useMemo<TTSSegmentSettings>(() => ({
    ttsProvider,
    ttsModel,
    voice,
    nativeSpeed: Number.isFinite(Number(voiceSpeed)) ? Number(voiceSpeed) : 1,
    ttsInstructions: ttsInstructions || '',
  }), [ttsProvider, ttsModel, voice, voiceSpeed, ttsInstructions]);

  const loadManifest = useCallback(async (
    mode: 'reset' | 'append' = 'reset',
    cursorOverride: string | null = null,
  ) => {
    if (!documentId) return;
    const cursor = mode === 'append' ? cursorOverride : null;
    if (mode === 'append' && !cursor) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (mode === 'reset') {
      setState({ kind: 'loading' });
    } else {
      setState((prev) => {
        if (prev.kind !== 'ready') return prev;
        return { ...prev, loadingMore: true };
      });
    }
    try {
      const params = new URLSearchParams({
        documentId,
        limit: String(MANIFEST_PAGE_SIZE),
      });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(
        `/api/tts/segments/manifest?${params.toString()}`,
        { signal: controller.signal, cache: 'no-store' },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as TTSSegmentsManifestResponse;
      setState((prev) => {
        const merged = mode === 'append' && prev.kind === 'ready'
          ? mergeRows(prev.data, data.segments)
          : mergeRows([], data.segments);
        return {
          kind: 'ready',
          data: merged,
          fetchedAt: Date.now(),
          nextCursor: data.nextCursor,
          hasMore: data.hasMore,
          loadingMore: false,
        };
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (mode === 'append' && err instanceof Error && err.message.includes('Invalid cursor')) {
        setState((prev) => {
          if (prev.kind !== 'ready') return prev;
          return {
            ...prev,
            loadingMore: false,
            hasMore: false,
            nextCursor: null,
          };
        });
        return;
      }
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load' });
    }
  }, [documentId]);

  const handleClearCache = useCallback(async () => {
    if (!documentId || isClearing) return;
    const confirmed = window.confirm('Clear cached segments for this document version? This removes stored segment metadata and audio objects.');
    if (!confirmed) return;

    setIsClearing(true);
    try {
      const res = await fetch('/api/tts/segments/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
        deletedSegments?: number;
        requestedAudioObjects?: number;
        deletedAudioObjects?: number;
        warning?: string;
      } | null;
      if (!res.ok) {
        throw new Error(payload?.error || `Request failed (${res.status})`);
      }

      if (payload?.warning) {
        toast.error(`Segments cleared, but audio cleanup was partial: ${payload.warning}`);
      } else if (payload) {
        const deletedSegments = Number(payload.deletedSegments ?? 0);
        const deletedAudioObjects = Number(payload.deletedAudioObjects ?? 0);
        const requestedAudioObjects = Number(payload.requestedAudioObjects ?? deletedAudioObjects);
        toast.success(`Cleared ${deletedSegments} segments and ${deletedAudioObjects}/${requestedAudioObjects} audio objects.`);
      }
      await loadManifest('reset');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to clear segments cache');
    } finally {
      setIsClearing(false);
    }
  }, [documentId, isClearing, loadManifest]);

  useEffect(() => {
    if (!isOpen) return;
    void loadManifest('reset');
    return () => {
      abortRef.current?.abort();
    };
  }, [isOpen, loadManifest]);

  useEffect(() => {
    if (!isOpen) return;
    const node = listRef.current;
    if (!node) return;

    const onScroll = () => {
      setState((prev) => {
        if (prev.kind !== 'ready' || !prev.hasMore || prev.loadingMore) return prev;
        const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
        if (distance > 280) return prev;
        void loadManifest('append', prev.nextCursor);
        return { ...prev, loadingMore: true };
      });
    };

    node.addEventListener('scroll', onScroll);
    return () => node.removeEventListener('scroll', onScroll);
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

  const handleRefresh = useCallback(() => {
    didAutoScrollOnOpenRef.current = false;
    void loadManifest('reset');
  }, [loadManifest]);

  const handleJump = useCallback((index: number, locator: TTSSegmentLocator | null) => {
    playFromSegment(index, locator);
  }, [playFromSegment]);

  const rowsToRender = useMemo(() => {
    if (state.kind !== 'ready') return [] as Array<{
      segmentIndex: number;
      sentenceText: string;
      row: TTSSegmentRow;
      isCurrentLocation: boolean;
      groupKey: string;
      groupLabel: string;
    }>;
    const currentRowsFromManifest = state.data.filter((row) =>
      locatorMatchesCurrent(row.locator, currDocPage, currDocPageNumber),
    );
    const nonCurrentRows = state.data.filter((row) =>
      !locatorMatchesCurrent(row.locator, currDocPage, currDocPageNumber),
    );

    const inferredCurrentLocator = (() => {
      const first = currentRowsFromManifest[0]?.locator;
      if (first) return first;
      if (typeof currDocPage === 'string' && currDocPage.length > 0) {
        return {
          location: currDocPage,
          readerType: 'epub' as const,
        };
      }
      if (typeof currDocPageNumber === 'number' && Number.isFinite(currDocPageNumber)) {
        return {
          page: Math.floor(currDocPageNumber),
          readerType: 'pdf' as const,
        };
      }
      return null;
    })();

    const variantsByIndex = new Map<number, TTSSegmentVariant[]>();
    for (const row of currentRowsFromManifest) {
      if (!variantsByIndex.has(row.segmentIndex)) {
        variantsByIndex.set(row.segmentIndex, []);
      }
      const merged = variantsByIndex.get(row.segmentIndex)!;
      const seenIds = new Set(merged.map((variant) => variant.segmentId));
      for (const variant of row.variants ?? []) {
        if (seenIds.has(variant.segmentId)) continue;
        seenIds.add(variant.segmentId);
        merged.push(variant);
      }
    }

    const currentRows: TTSSegmentRow[] = sentences.map((_, segmentIndex) => ({
      segmentIndex,
      locator: inferredCurrentLocator,
      variants: variantsByIndex.get(segmentIndex) ?? [],
    }));

    const mergedRows = [...currentRows, ...nonCurrentRows].sort(compareRows);
    return mergedRows.map((row) => {
      const isCurrentLocation = locatorMatchesCurrent(row.locator, currDocPage, currDocPageNumber);
      return {
        segmentIndex: row.segmentIndex,
        sentenceText: isCurrentLocation ? (sentences[row.segmentIndex] ?? '') : '',
        row,
        isCurrentLocation,
        groupKey: locatorGroupKey(row.locator),
        groupLabel: formatLocatorGroupLabel(row.locator),
      };
    });
  }, [state, currDocPage, currDocPageNumber, sentences]);

  const totalVariants = state.kind === 'ready'
    ? rowsToRender.reduce((sum, r) => sum + r.row.variants.length, 0)
    : 0;

  useEffect(() => {
    if (!isOpen) {
      didAutoScrollOnOpenRef.current = false;
      return;
    }
    if (didAutoScrollOnOpenRef.current) return;
    if (state.kind !== 'ready' || rowsToRender.length === 0) return;

    const container = listRef.current;
    if (!container) return;
    const activeRow = container.querySelector<HTMLElement>('[data-active-segment="true"]');
    if (!activeRow) return;

    requestAnimationFrame(() => {
      activeRow.scrollIntoView({ block: 'center', behavior: 'auto' });
      didAutoScrollOnOpenRef.current = true;
    });
  }, [isOpen, state.kind, rowsToRender.length, currentSentenceIndex]);

  useEffect(() => {
    if (!isOpen || !isPlaying) return;
    if (state.kind !== 'ready' || rowsToRender.length === 0) return;

    const root = listRef.current;
    if (!root) return;
    const activeRow = root.querySelector<HTMLElement>('[data-active-segment="true"]');
    if (!activeRow) return;

    const scrollContainer = findScrollableAncestor(activeRow, root);
    if (!scrollContainer) return;
    if (isElementFullyVisibleWithinContainer(activeRow, scrollContainer)) return;

    requestAnimationFrame(() => {
      activeRow.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  }, [
    isOpen,
    isPlaying,
    state.kind,
    rowsToRender.length,
    currentSentenceIndex,
    currDocPage,
    currDocPageNumber,
  ]);

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
        onClick={handleRefresh}
        aria-label="Refresh segments"
        title="Refresh"
        className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-offbase bg-base text-muted hover:bg-offbase hover:text-accent transition-colors"
      >
        <RefreshIcon className="w-3.5 h-3.5" />
      </button>
    </>
  );

  return (
    <ReaderSidebarShell
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      ariaLabel="TTS segments"
      title="Segments"
      subtitle="Click an index or sentence to jump. Click a voice label to switch the active voice."
      headerActions={headerActions}
      bodyClassName="flex-1 overflow-y-auto px-0 py-0"
    >
      <div className="px-4 py-2 border-b border-offbase">
        <div className="text-xs text-muted">
          {state.kind === 'ready' ? (
            <>
              {rowsToRender.length} indexed
              <span> · </span>
              {totalVariants} variants
              {state.hasMore ? (
                <>
                  <span> · </span>
                  more…
                </>
              ) : null}
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

      <div ref={listRef} className="flex-1 overflow-y-auto">
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
                  {rowsToRender.map(({ segmentIndex, sentenceText, row, isCurrentLocation, groupKey, groupLabel }, rowIndex) => {
                    const previousGroupKey = rowIndex > 0 ? rowsToRender[rowIndex - 1]?.groupKey : null;
                    const showGroupHeader = previousGroupKey !== groupKey;
                    const isCurrent = isCurrentLocation && segmentIndex === currentSentenceIndex;
                    const variants = row.variants ?? [];
                    const bestVariant = variants
                      .slice()
                      .sort((a, b) => {
                        const rank = (status: TTSSegmentVariant['status']) => {
                          if (status === 'completed') return 3;
                          if (status === 'pending') return 2;
                          return 1;
                        };
                        const byRank = rank(b.status) - rank(a.status);
                        if (byRank !== 0) return byRank;
                        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
                      })[0] ?? null;
                    const activeVariant = variants.find((v) => settingsAreEqual(v.settings, activeSettings))
                      ?? bestVariant;
                    const status = activeVariant?.status ?? 'pending';
                    const canJump = !!row.locator || sentenceText.length > 0;
                    const playable = !!(activeVariant && activeVariant.audioPresignUrl);
                    return (
                      <li
                        key={`${groupKey}::${segmentIndex}`}
                        data-active-segment={isCurrent ? 'true' : undefined}
                        className={`relative px-4 py-3 ${isCurrent ? 'bg-offbase/40' : ''}`}
                      >
                        {showGroupHeader && (
                          <div className="mb-2 -mx-4 px-4 py-1.5 bg-offbase/30 border-y border-offbase">
                            <span className="text-[10px] uppercase tracking-[0.14em] text-muted">
                              {groupLabel}
                            </span>
                          </div>
                        )}
                        {isCurrent && (
                          <span className="absolute inset-y-2 left-0 w-0.5 bg-accent rounded-r" aria-hidden />
                        )}
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => { if (canJump) handleJump(segmentIndex, row.locator); }}
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
                              onClick={() => { if (canJump) handleJump(segmentIndex, row.locator); }}
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

                          <SegmentMetadataPopover row={row} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {state.kind === 'ready' && state.loadingMore && (
                <div className="px-4 py-3 text-xs text-muted">Loading more segments…</div>
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
