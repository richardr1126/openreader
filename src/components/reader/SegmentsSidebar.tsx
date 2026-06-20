'use client';

import { Fragment, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import { Transition } from '@headlessui/react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Book } from 'epubjs';
import toast from 'react-hot-toast';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { RefreshIcon, InfoIcon } from '@/components/icons/Icons';
import { Button, IconButton, PopoverIconTrigger, PopoverRoot, PopoverSurface } from '@/components/ui';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { compareSegmentLocators, locatorGroupKey, locatorIdentityKey } from '@openreader/tts/locator';
import { resolveSpineFromCfi } from '@/lib/client/epub/spine-coordinates';
import {
  isHtmlLocator,
  isPdfLocator,
  isStableEpubLocator,
} from '@/types/client';
import type {
  TTSSegmentLocator,
  TTSSegmentRow,
  TTSSegmentSettings,
  TTSSegmentVariant,
  TTSSegmentsManifestResponse,
} from '@/types/client';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';

interface SegmentsSidebarProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  documentId: string;
  epubBookRef?: RefObject<Book | null>;
}

const MANIFEST_PAGE_SIZE = 150;
type ClearSegmentsPayload = {
  error?: string;
  deletedSegments?: number;
  requestedAudioObjects?: number;
  deletedAudioObjects?: number;
  invalidatedPlaybackSessions?: number;
  warning?: string;
};

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
    a.providerRef === b.providerRef
    && a.providerType === b.providerType
    && a.ttsModel === b.ttsModel
    && a.voice === b.voice
    && Number(a.nativeSpeed) === Number(b.nativeSpeed)
    && (a.ttsInstructions || '') === (b.ttsInstructions || '')
    && (a.language || 'en') === (b.language || 'en')
  );
}

function statusColor(status: TTSSegmentVariant['status']): string {
  if (status === 'completed') return 'bg-accent';
  if (status === 'error') return 'bg-danger';
  return 'bg-muted';
}

function formatLocatorGroupLabel(locator: TTSSegmentLocator | null): string {
  if (!locator) return 'Unknown location';
  if (isStableEpubLocator(locator)) {
    // Show the spine item filename as a recognisable chapter label. epubjs
    // hrefs look like "OEBPS/Chapter_03.xhtml" — strip the directory for the
    // primary label and keep the index for tie-breaks.
    const base = locator.spineHref.split('/').pop() || locator.spineHref;
    const stem = base.replace(/\.x?html?$/i, '');
    return `${stem} · EPUB`;
  }
  if (isPdfLocator(locator)) {
    return `Page ${Math.floor(locator.page)} · PDF`;
  }
  if (isHtmlLocator(locator)) {
    if (/^\d+$/.test(locator.location)) {
      return `Block ${locator.location} · Text`;
    }
    return `${locator.location} · Text`;
  }
  return 'Unknown location';
}

function compareRows(a: TTSSegmentRow, b: TTSSegmentRow): number {
  const byLocator = compareSegmentLocators(a.locator, b.locator);
  if (byLocator !== 0) return byLocator;
  if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
  return locatorIdentityKey(a.locator).localeCompare(locatorIdentityKey(b.locator));
}

function mergeRows(existing: TTSSegmentRow[], incoming: TTSSegmentRow[]): TTSSegmentRow[] {
  const map = new Map<string, TTSSegmentRow>();
  const upsert = (row: TTSSegmentRow) => {
    // Identity key (NOT the coarse sidebar group key) so that two rows in the
    // same chapter at different charOffsets stay as separate entries instead
    // of collapsing into one.
    const key = `${row.segmentIndex}|${locatorIdentityKey(row.locator)}`;
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

export function SegmentsSidebar({ isOpen, setIsOpen, documentId, epubBookRef }: SegmentsSidebarProps) {
  const queryClient = useQueryClient();
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const {
    sentences,
    playbackSegments,
    playbackPlanSource,
    currentSentenceIndex,
    currDocPage,
    currDocPageNumber,
    isPlaying,
    playFromSegment,
    activeReaderType,
    clearSegmentCaches,
    resolvedLanguage,
    setDocumentLanguage,
  } = useTTS();
  const {
    providerRef,
    providerType,
    ttsModel,
    voice,
    voiceSpeed,
    ttsInstructions,
    updateConfigKey,
  } = useConfig();

  const currentEpubSpine = useMemo(() => {
    if (activeReaderType !== 'epub' || typeof currDocPage !== 'string' || currDocPage.length === 0) {
      return null;
    }
    const book = epubBookRef?.current;
    return book?.isOpen ? resolveSpineFromCfi(book, currDocPage) : null;
  }, [activeReaderType, currDocPage, epubBookRef]);

  const sidebarSynthItems = useMemo(() => {
    type SynthItem = {
      segmentIndex: number;
      text: string;
      segmentKey: string | null;
      locator: TTSSegmentLocator | null;
    };

    if (playbackPlanSource !== 'worker' || playbackSegments.length === 0) {
      return [];
    }

    if (activeReaderType === 'epub' && currentEpubSpine) {
      const chapterItems = playbackSegments
        .map<SynthItem | null>((segment, index) => {
          const locator = segment.ownerLocator;
          if (!isStableEpubLocator(locator)) return null;
          if (
            locator.spineIndex !== currentEpubSpine.index
            || locator.spineHref !== currentEpubSpine.href
          ) {
            return null;
          }
          return {
            segmentIndex: index,
            text: segment.text,
            segmentKey: segment.key,
            locator,
          };
        })
        .filter((item): item is SynthItem => item !== null);
      return chapterItems;
    }

    return playbackSegments.map<SynthItem | null>((segment, index) => {
      const text = segment.text || sentences[index] || '';
      if (!text.trim()) return null;
      return {
        segmentIndex: index,
        text,
        segmentKey: segment.key ?? null,
        locator: segment.ownerLocator ?? null,
      };
    }).filter((item): item is SynthItem => item !== null);
  }, [activeReaderType, currentEpubSpine, playbackPlanSource, playbackSegments, sentences]);

  const visiblePlanItems = useMemo(() => {
    if (activeReaderType !== 'epub' || currentEpubSpine) return sidebarSynthItems;
    return [];
  }, [activeReaderType, currentEpubSpine, sidebarSynthItems]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const didAutoScrollOnOpenRef = useRef(false);
  const userScrollUntilMsRef = useRef(0);
  const programmaticScrollUntilMsRef = useRef(0);
  const lastSegmentRefreshKeyRef = useRef('');
  const manifestScopeKey = activeReaderType === 'epub' && currentEpubSpine
    ? `epub:${currentEpubSpine.index}:${currentEpubSpine.href}`
    : 'document';
  const segmentsQueryKey = useMemo(
    () => queryKeys.ttsManifest(session?.user?.id ?? 'no-session', documentId, manifestScopeKey),
    [documentId, manifestScopeKey, session?.user?.id],
  );

  const segmentsQuery = useInfiniteQuery({
    queryKey: segmentsQueryKey,
    enabled: !isSessionPending && isOpen && !!documentId && (activeReaderType !== 'epub' || !!currentEpubSpine),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      if (!documentId) {
        return {
          documentId: '',
          segments: [],
          hasMore: false,
          nextCursor: null,
        } satisfies TTSSegmentsManifestResponse;
      }
      const cursor = typeof pageParam === 'string' && pageParam.length > 0 ? pageParam : null;
      const params = new URLSearchParams({
        documentId,
        limit: String(MANIFEST_PAGE_SIZE),
      });
      if (activeReaderType === 'epub' && currentEpubSpine) {
        params.set('readerType', 'epub');
        params.set('spineIndex', String(currentEpubSpine.index));
        params.set('spineHref', currentEpubSpine.href);
      }
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/tts/segments/manifest?${params.toString()}`, {
        signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // If a stale cursor becomes invalid between page fetches, stop
        // pagination for this query instead of surfacing a hard error.
        if (cursor && body.toLowerCase().includes('invalid cursor')) {
          return {
            documentId,
            segments: [],
            hasMore: false,
            nextCursor: null,
          } satisfies TTSSegmentsManifestResponse;
        }
        throw new Error(body || `Request failed (${res.status})`);
      }
      return (await res.json()) as TTSSegmentsManifestResponse;
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
  });
  const {
    data: manifestData,
    isPending: isManifestPending,
    isError: hasManifestError,
    error: manifestError,
    hasNextPage: hasMoreManifestPages,
    isFetchingNextPage: isLoadingMoreManifest,
    fetchNextPage,
    refetch: refetchManifest,
  } = segmentsQuery;

  const manifestRows = useMemo(() => {
    const pages = manifestData?.pages ?? [];
    if (pages.length === 0) return [] as TTSSegmentRow[];
    return pages.reduce<TTSSegmentRow[]>((acc, page) => mergeRows(acc, page.segments), []);
  }, [manifestData]);

  const clearSegmentsMutation = useMutation({
    mutationFn: async (): Promise<ClearSegmentsPayload | null> => {
      if (!documentId) throw new Error('Missing document id');
      const res = await fetch('/api/tts/segments/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      const payload = (await res.json().catch(() => null)) as ClearSegmentsPayload | null;
      if (!res.ok) {
        throw new Error(payload?.error || `Request failed (${res.status})`);
      }
      return payload;
    },
    onSuccess: async (payload) => {
      clearSegmentCaches();
      if (payload?.warning) {
        toast.error(`Segments cleared, but audio cleanup was partial: ${payload.warning}`);
      } else if (payload) {
        const deletedSegments = Number(payload.deletedSegments ?? 0);
        const deletedAudioObjects = Number(payload.deletedAudioObjects ?? 0);
        const requestedAudioObjects = Number(payload.requestedAudioObjects ?? deletedAudioObjects);
        toast.success(`Cleared ${deletedSegments} segments and ${deletedAudioObjects}/${requestedAudioObjects} audio objects.`);
      }
      await queryClient.invalidateQueries({ queryKey: segmentsQueryKey });
      await queryClient.refetchQueries({ queryKey: segmentsQueryKey, type: 'active' });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to clear segments cache');
    },
  });
  const { mutateAsync: clearSegments, isPending: isClearingSegments } = clearSegmentsMutation;

  const activeSettings = useMemo<TTSSegmentSettings>(() => ({
    providerRef,
    providerType,
    ttsModel,
    voice,
    nativeSpeed: Number.isFinite(Number(voiceSpeed)) ? Number(voiceSpeed) : 1,
    ttsInstructions: ttsInstructions || '',
    language: resolvedLanguage,
  }), [providerRef, providerType, ttsModel, voice, voiceSpeed, ttsInstructions, resolvedLanguage]);

  const handleClearCache = useCallback(async () => {
    if (!documentId || isClearingSegments) return;
    const confirmed = window.confirm('Clear cached segments for this document version? This removes stored segment metadata and audio objects.');
    if (!confirmed) return;
    await clearSegments();
  }, [documentId, isClearingSegments, clearSegments]);

  useEffect(() => {
    if (!isOpen || !isPlaying) return;
    const locationKey = activeReaderType === 'epub'
      ? String(currDocPage)
      : String(currDocPageNumber);
    const refreshKey = `${activeReaderType}|${locationKey}|${currentSentenceIndex}`;
    if (lastSegmentRefreshKeyRef.current === refreshKey) return;
    lastSegmentRefreshKeyRef.current = refreshKey;
    void refetchManifest();
  }, [
    isOpen,
    isPlaying,
    activeReaderType,
    currDocPage,
    currDocPageNumber,
    currentSentenceIndex,
    refetchManifest,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const node = listRef.current;
    if (!node) return;

    const markUserScrollActive = () => {
      userScrollUntilMsRef.current = Date.now() + 1200;
    };

    const onScroll = () => {
      if (Date.now() > programmaticScrollUntilMsRef.current) {
        markUserScrollActive();
      }
      if (!hasMoreManifestPages || isLoadingMoreManifest) return;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (distance > 280) return;
      void fetchNextPage();
    };

    const onWheel = () => markUserScrollActive();
    const onTouchMove = () => markUserScrollActive();

    node.addEventListener('scroll', onScroll);
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchmove', onTouchMove);
    };
  }, [isOpen, hasMoreManifestPages, isLoadingMoreManifest, fetchNextPage]);

  const handleSelectVariant = useCallback(async (settings: TTSSegmentSettings | null) => {
    if (!settings) return;
    await Promise.all([
      updateConfigKey('providerRef', settings.providerRef),
      updateConfigKey('providerType', settings.providerType),
      updateConfigKey('ttsModel', settings.ttsModel),
      updateConfigKey('voice', settings.voice),
      updateConfigKey('voiceSpeed', Number.isFinite(Number(settings.nativeSpeed)) ? Number(settings.nativeSpeed) : 1),
      updateConfigKey('ttsInstructions', settings.ttsInstructions || ''),
    ]);
    if (settings.language) setDocumentLanguage(settings.language);
  }, [updateConfigKey, setDocumentLanguage]);

  const handleRefresh = useCallback(() => {
    didAutoScrollOnOpenRef.current = false;
    void queryClient.invalidateQueries({ queryKey: segmentsQueryKey });
    void refetchManifest();
  }, [queryClient, segmentsQueryKey, refetchManifest]);

  const handleJump = useCallback((index: number, locator: TTSSegmentLocator | null) => {
    playFromSegment(index, locator);
  }, [playFromSegment]);

  const rowsToRender = useMemo(() => {
    type Entry = {
      segmentIndex: number;
      displayIndex: number;
      sentenceText: string;
      row: TTSSegmentRow;
      isCurrentLocation: boolean;
      groupKey: string;
      groupLabel: string;
      /**
       * Synthesized rows are UI projections from the worker plan. For EPUB,
       * render only the current spine window so pagination changes do not
       * reintroduce viewport-local sentence lists.
       */
      isSynthesized: boolean;
    };
    if (visiblePlanItems.length === 0) return [] as Entry[];

    // Best-known locator for the live viewport. Used when a worker-plan row has
    // no row-specific locator yet, and for PDF/HTML where spine coordinates do
    // not exist.
    const inferredCurrentLocator: TTSSegmentLocator | null = (() => {
      if (activeReaderType === 'epub' && typeof currDocPage === 'string' && currDocPage.length > 0) {
        if (currentEpubSpine) {
          return {
            readerType: 'epub',
            spineHref: currentEpubSpine.href,
            spineIndex: currentEpubSpine.index,
            charOffset: 0,
            cfi: currDocPage,
          };
        }
        return null;
      }
      if (activeReaderType === 'html') {
        if (typeof currDocPage === 'string' && currDocPage.length > 0) {
          return { readerType: 'html', location: currDocPage };
        }
        if (typeof currDocPageNumber === 'number' && Number.isFinite(currDocPageNumber)) {
          return { readerType: 'html', location: String(Math.floor(currDocPageNumber)) };
        }
        return null;
      }
      if (typeof currDocPageNumber === 'number' && Number.isFinite(currDocPageNumber)) {
        return { readerType: 'pdf', page: Math.floor(currDocPageNumber) };
      }
      return null;
    })();

    // Index manifest rows so worker-plan rows can attach persisted status/audio
    // variants. Manifest rows are never rendered by themselves because they do
    // not carry text; the worker plan is the sidebar text source.
    const visibleManifestRows = activeReaderType === 'epub' && currentEpubSpine
      ? manifestRows.filter((row) =>
          isStableEpubLocator(row.locator)
          && row.locator.spineIndex === currentEpubSpine.index
          && row.locator.spineHref === currentEpubSpine.href
        )
      : manifestRows;

    const manifestBySegmentIdentity = new Map<string, TTSSegmentRow>();
    const manifestBySegmentKey = new Map<string, TTSSegmentRow[]>();
    for (const row of visibleManifestRows) {
      if (!row.segmentKey) continue;
      manifestBySegmentIdentity.set(`${row.segmentKey}|${locatorIdentityKey(row.locator)}`, row);
      const bucket = manifestBySegmentKey.get(row.segmentKey) ?? [];
      bucket.push(row);
      manifestBySegmentKey.set(row.segmentKey, bucket);
    }

    const entries: Entry[] = [];

    for (let rowIndex = 0; rowIndex < visiblePlanItems.length; rowIndex += 1) {
      const item = visiblePlanItems[rowIndex]!;
      const segmentKey = item.segmentKey;
      const manifestMatch = segmentKey
        ? (
            manifestBySegmentIdentity.get(`${segmentKey}|${locatorIdentityKey(item.locator)}`)
            ?? (manifestBySegmentKey.get(segmentKey)?.length === 1 ? manifestBySegmentKey.get(segmentKey)![0] : undefined)
          )
        : undefined;
      const rowLocator = item.locator ?? manifestMatch?.locator ?? inferredCurrentLocator;
      if (!rowLocator) continue;
      const row: TTSSegmentRow = {
        segmentIndex: item.segmentIndex,
        segmentKey,
        locator: rowLocator,
        variants: manifestMatch?.variants ?? [],
      };
      entries.push({
        segmentIndex: item.segmentIndex,
        displayIndex: rowIndex,
        sentenceText: item.text,
        row,
        isCurrentLocation: true,
        groupKey: locatorGroupKey(rowLocator),
        groupLabel: formatLocatorGroupLabel(rowLocator),
        isSynthesized: true,
      });
    }

    entries.sort((a, b) => {
      const byLocator = compareSegmentLocators(a.row.locator, b.row.locator);
      if (byLocator !== 0) return byLocator;
      return a.displayIndex - b.displayIndex;
    });

    return entries;
  }, [manifestRows, currDocPage, currDocPageNumber, visiblePlanItems, currentEpubSpine, activeReaderType]);

  const totalVariants = rowsToRender.reduce((sum, r) => sum + r.row.variants.length, 0);

  const hasLoadedManifest = playbackPlanSource === 'worker' || !!manifestData;
  const isManifestLoading = isManifestPending && !manifestData;
  const manifestErrorMessage = manifestError instanceof Error ? manifestError.message : 'Failed to load';

  useEffect(() => {
    if (!isOpen) {
      didAutoScrollOnOpenRef.current = false;
      return;
    }
    if (didAutoScrollOnOpenRef.current) return;
    if (!hasLoadedManifest || rowsToRender.length === 0) return;

    const container = listRef.current;
    if (!container) return;
    if (Date.now() < userScrollUntilMsRef.current) return;
    const activeRow = container.querySelector<HTMLElement>('[data-active-segment="true"]');
    if (!activeRow) return;

    requestAnimationFrame(() => {
      programmaticScrollUntilMsRef.current = Date.now() + 300;
      activeRow.scrollIntoView({ block: 'center', behavior: 'auto' });
      didAutoScrollOnOpenRef.current = true;
    });
  }, [isOpen, hasLoadedManifest, rowsToRender.length, currentSentenceIndex]);

  useEffect(() => {
    if (!isOpen || !isPlaying) return;
    if (!hasLoadedManifest || rowsToRender.length === 0) return;

    const root = listRef.current;
    if (!root) return;
    if (Date.now() < userScrollUntilMsRef.current) return;
    const activeRow = root.querySelector<HTMLElement>('[data-active-segment="true"]');
    if (!activeRow) return;

    const scrollContainer = findScrollableAncestor(activeRow, root);
    if (!scrollContainer) return;
    if (isElementFullyVisibleWithinContainer(activeRow, scrollContainer)) return;

    requestAnimationFrame(() => {
      programmaticScrollUntilMsRef.current = Date.now() + 300;
      activeRow.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  }, [
    isOpen,
    isPlaying,
    hasLoadedManifest,
    rowsToRender.length,
    currentSentenceIndex,
    currDocPage,
    currDocPageNumber,
  ]);

  const headerActions = (
    <>
      <Button
        onClick={() => void handleClearCache()}
        aria-label="Clear segments cache"
        title="Clear cache for listed segments"
        disabled={isClearingSegments}
        variant="secondary"
        size="xs"
        className="h-8 px-2 text-soft"
      >
        {isClearingSegments ? 'Clearing…' : 'Clear'}
      </Button>
      <IconButton
        onClick={handleRefresh}
        aria-label="Refresh segments"
        title="Refresh"
        tone="surface"
        size="md"
        className="h-8 w-8 text-soft"
      >
        <RefreshIcon className="w-3.5 h-3.5" />
      </IconButton>
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
      <div className="px-4 py-2 border-b border-line-soft">
        <div className="text-xs text-soft">
          {hasLoadedManifest ? (
            <>
              {rowsToRender.length} indexed
              <span> · </span>
              {totalVariants} variants
              {hasMoreManifestPages ? (
                <>
                  <span> · </span>
                  more…
                </>
              ) : null}
            </>
          ) : isManifestLoading ? (
            <div className="animate-pulse h-3 w-36 rounded bg-surface-sunken" aria-label="Loading segment summary" aria-busy="true" />
          ) : hasManifestError ? (
            <span className="text-danger">error</span>
          ) : (
            <span>—</span>
          )}
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto">
              {hasManifestError && (
                <div className="px-4 py-6 text-sm text-danger">{manifestErrorMessage}</div>
              )}
              {isManifestLoading && (
                <SegmentsListSkeleton />
              )}
              {hasLoadedManifest && rowsToRender.length === 0 && (
                <div className="px-4 py-10 flex flex-col items-center text-center gap-2">
                  <div className="text-sm font-medium text-soft">
                    No segments
                  </div>
                  <p className="text-sm text-soft leading-relaxed max-w-[24ch]">
                    Press play in the reader to generate audio segments.
                  </p>
                </div>
              )}
              {hasLoadedManifest && rowsToRender.length > 0 && (
                <ul className="divide-y divide-line-soft">
                  {rowsToRender.map(({ segmentIndex, displayIndex, sentenceText, row, isCurrentLocation, groupKey, groupLabel, isSynthesized }, rowIndex) => {
                    const previousGroupKey = rowIndex > 0 ? rowsToRender[rowIndex - 1]?.groupKey : null;
                    const showGroupHeader = previousGroupKey !== groupKey;
                    const isCurrent = isPlaying && isCurrentLocation && segmentIndex === currentSentenceIndex;
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
                        key={`${isSynthesized ? 'syn' : 'mfr'}::${groupKey}::${segmentIndex}::${rowIndex}`}
                        data-active-segment={isCurrent ? 'true' : undefined}
                        className={`relative px-4 py-3 ${isCurrent ? 'bg-surface-sunken' : ''}`}
                      >
                        {showGroupHeader && (
                          <div className="mb-2 -mx-4 px-4 py-1.5 bg-surface-sunken border-y border-line">
                            <span className="text-[10px] uppercase tracking-[0.14em] text-soft">
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
                            className={`text-xs font-medium shrink-0 pt-0.5 ${canJump ? 'text-soft hover:text-accent' : 'text-faint cursor-not-allowed'}`}
                            title={playable ? 'Play this segment' : 'Jump to this segment'}
                            aria-label={`Segment ${displayIndex + 1}`}
                          >
                            {formatIndex(displayIndex)}
                          </button>

                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => { if (canJump) handleJump(segmentIndex, row.locator); }}
                              disabled={!canJump}
                              className={`block w-full text-left ${canJump ? '' : 'cursor-not-allowed'}`}
                            >
                              <p className={`text-sm leading-snug ${isCurrent ? 'text-foreground' : 'text-soft'} line-clamp-2`}>
                                {sentenceText}
                              </p>
                            </button>

                            <div className="mt-1 flex items-center gap-2 flex-wrap">
                              <span
                                className={`inline-block w-1.5 h-1.5 rounded-full ${statusColor(status)}`}
                                aria-label={`Status ${status}`}
                                title={status}
                              />
                              <span className="text-xs text-soft">
                                {formatDuration(activeVariant?.durationMs)}
                              </span>
                              {isCurrent && isPlaying && (
                                <span className="text-xs text-accent font-medium">
                                  playing
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
                                            ? `${variant.settings.providerRef} · ${variant.settings.ttsModel} · ${variant.settings.voice}${variant.settings.nativeSpeed && variant.settings.nativeSpeed !== 1 ? ` · ${variant.settings.nativeSpeed}×` : ''}`
                                            : 'Unknown variant'
                                        }
                                        className={[
                                          'max-w-full whitespace-normal break-words text-left leading-none text-[10px] px-1 py-0.5 rounded border transition-colors',
                                          isActive
                                            ? 'border-accent text-accent bg-surface-sunken'
                                            : known
                                              ? 'border-line text-soft hover:border-accent hover:text-accent'
                                              : 'border-line text-soft opacity-60 cursor-not-allowed',
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
              {hasLoadedManifest && isLoadingMoreManifest && (
                <SegmentsListSkeletonRows />
              )}
      </div>
    </ReaderSidebarShell>
  );
}

function SegmentsListSkeleton() {
  return (
    <div className="px-4 py-3">
      <div className="animate-pulse space-y-3" aria-label="Loading segments" aria-busy="true">
        <div className="h-3 w-40 rounded bg-surface-sunken" />
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="rounded-md border border-line bg-surface px-3 py-2.5">
            <div className="flex items-start gap-3">
              <div className="h-3.5 w-8 rounded bg-surface-sunken mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-3.5 w-11/12 rounded bg-surface-sunken" />
                <div className="h-3.5 w-3/4 rounded bg-surface-sunken" />
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-surface-sunken" />
                  <div className="h-3 w-12 rounded bg-surface-sunken" />
                  <div className="h-4 w-20 rounded bg-surface-sunken" />
                </div>
              </div>
              <div className="h-6 w-6 rounded bg-surface-sunken shrink-0" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SegmentsListSkeletonRows() {
  return (
    <div className="px-4 py-3 animate-pulse" aria-label="Loading more segments" aria-busy="true">
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-12 rounded-md border border-line bg-surface" />
        ))}
      </div>
    </div>
  );
}

function SegmentMetadataPopover({ row }: { row: TTSSegmentRow }) {
  return (
    <PopoverRoot className="relative shrink-0">
      <PopoverIconTrigger
        size="sm"
        aria-label="Segment metadata"
        title="Metadata"
      >
        <InfoIcon className="w-3.5 h-3.5" />
      </PopoverIconTrigger>
      <Transition
        as={Fragment}
        enter="transition ease-standard duration-fast"
        enterFrom="opacity-0 translate-y-1"
        enterTo="opacity-100 translate-y-0"
        leave="transition ease-standard duration-fast"
        leaveFrom="opacity-100 translate-y-0"
        leaveTo="opacity-0 translate-y-1"
      >
        <PopoverSurface
          anchor="bottom end"
          className="z-[60] w-[300px] mt-1"
        >
          <dl className="space-y-2">
            <Row label="locator">
              {row.locator ? (
                <span className="font-mono tabular-nums text-[11px] text-foreground break-all">
                  {isStableEpubLocator(row.locator)
                    ? `epub spine[${row.locator.spineIndex}] ${row.locator.spineHref} @${row.locator.charOffset}`
                    : isPdfLocator(row.locator)
                      ? `pdf p.${row.locator.page}`
                      : isHtmlLocator(row.locator)
                        ? `html ${row.locator.location}`
                        : `${row.locator.readerType || '?'} (unmapped)`}
                </span>
              ) : (
                <span className="text-soft text-[11px]">none</span>
              )}
            </Row>
            <Row label="variants">
              <span className="font-mono tabular-nums text-[11px] text-foreground">
                {row.variants.length}
              </span>
            </Row>
            {row.variants.map((v) => (
              <div key={v.segmentId} className="border-t border-line-soft pt-2">
                <Row label="segment_id">
                  <span className="font-mono text-[10px] text-soft break-all">
                    {v.segmentId.slice(0, 16)}…
                  </span>
                </Row>
                <Row label="settings">
                  <span className="font-mono text-[10px] text-foreground">
                    {v.settings
                      ? `${v.settings.providerRef} · ${v.settings.ttsModel} · ${formatVoiceLabel(v.settings)}`
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
        </PopoverSurface>
      </Transition>
    </PopoverRoot>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2 items-baseline">
      <dt className="font-mono uppercase tracking-[0.16em] text-[9px] text-soft">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
