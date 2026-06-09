'use client';

import { Fragment, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Transition } from '@headlessui/react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Book } from 'epubjs';
import toast from 'react-hot-toast';
import { useTTS } from '@/contexts/TTSContext';
import { useConfig } from '@/contexts/ConfigContext';
import { RefreshIcon, InfoIcon } from '@/components/icons/Icons';
import { Button, IconButton, PopoverIconTrigger, PopoverRoot, PopoverSurface } from '@/components/ui';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { compareSegmentLocators, locatorGroupKey, locatorIdentityKey } from '@/lib/shared/tts-locator';
import { buildSegmentKey, buildSegmentKeyPrefix } from '@/lib/shared/tts-segment-plan';
import {
  canonicalizeEpubSegmentsAgainstSpineText,
  type CanonicalizedEpubSegment,
} from '@/lib/client/epub/canonicalize-epub-segment';
import {
  getSpineItemPlainText,
  resolveMonotonicSentenceOffsets,
  resolveSpineFromCfi,
} from '@/lib/client/epub/spine-coordinates';
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

interface SegmentsSidebarProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  documentId: string;
  epubBookRef?: RefObject<Book | null>;
}

const MANIFEST_PAGE_SIZE = 150;
const SEGMENTS_MANIFEST_QUERY_KEY = 'tts-segments-manifest';

type ClearSegmentsPayload = {
  error?: string;
  deletedSegments?: number;
  requestedAudioObjects?: number;
  deletedAudioObjects?: number;
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
  const {
    sentences,
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
    ttsSegmentMaxBlockLength,
    updateConfigKey,
  } = useConfig();

  /**
   * Canonicalized per-sentence identities for the currently rendered page.
   * Each local sentence is mapped onto the spine-level canonical segment plan
   * (forward-only ordinal walk), so overlap-boundary local splits still resolve
   * to the same canonical `segmentKey`/`charOffset` as persisted rows.
   */
  const [synthRowCanonical, setSynthRowCanonical] = useState<Array<CanonicalizedEpubSegment | null>>([]);
  useEffect(() => {
    if (typeof currDocPage !== 'string' || !currDocPage || sentences.length === 0) {
      setSynthRowCanonical([]);
      return;
    }
    const book = epubBookRef?.current;
    if (!book?.isOpen) {
      setSynthRowCanonical([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const spine = resolveSpineFromCfi(book, currDocPage);
        if (!spine) {
          if (!cancelled) setSynthRowCanonical([]);
          return;
        }
        const spineText = await getSpineItemPlainText(book, spine.href);
        if (cancelled) return;
        const offsets = resolveMonotonicSentenceOffsets(spineText, sentences);
        const next = canonicalizeEpubSegmentsAgainstSpineText({
          segmentTexts: sentences,
          hintCharOffsets: offsets,
          spineText,
          spineHref: spine.href,
          spineIndex: spine.index,
          cfi: currDocPage,
          keyPrefix: buildSegmentKeyPrefix(documentId, activeReaderType),
          maxBlockLength: ttsSegmentMaxBlockLength,
          language: resolvedLanguage,
        });
        if (!cancelled) setSynthRowCanonical(next);
      } catch (error) {
        // Don't leave a previous page's canonical mapping in place if this
        // resolution fails — clear it so we fall back to non-canonical rows.
        console.warn('Failed to canonicalize EPUB sidebar segments:', error);
        if (!cancelled) setSynthRowCanonical([]);
      }
    })();
    return () => { cancelled = true; };
  }, [epubBookRef, currDocPage, sentences, documentId, activeReaderType, ttsSegmentMaxBlockLength, resolvedLanguage]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const didAutoScrollOnOpenRef = useRef(false);
  const userScrollUntilMsRef = useRef(0);
  const programmaticScrollUntilMsRef = useRef(0);
  const lastSegmentRefreshKeyRef = useRef('');
  const segmentsQueryKey = useMemo(
    () => [SEGMENTS_MANIFEST_QUERY_KEY, documentId] as const,
    [documentId],
  );

  const segmentsQuery = useInfiniteQuery({
    queryKey: segmentsQueryKey,
    enabled: isOpen && !!documentId,
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
      sentenceText: string;
      row: TTSSegmentRow;
      isCurrentLocation: boolean;
      groupKey: string;
      groupLabel: string;
      /**
       * Synthesized rows are produced locally from the currently rendered page's
       * sentences. They carry sentence text and the live-play highlight. Manifest
       * rows come from the server-side manifest and may overlap synthesized rows
       * for the current page; we render them as their own listings so the
       * sidebar can show the rest of the chapter (and other chapters) without
       * needing to re-derive page boundaries on the client.
       */
      isSynthesized: boolean;
    };
    if (!manifestData) return [] as Entry[];

    // Fallback locator for the live viewport. Used when per-sentence
    // canonical resolution hasn't completed yet and for PDF/HTML, which don't
    // have a spine concept.
    const inferredCurrentLocator: TTSSegmentLocator | null = (() => {
      if (activeReaderType === 'epub' && typeof currDocPage === 'string' && currDocPage.length > 0) {
        const book = epubBookRef?.current;
        const spine = book && book.isOpen ? resolveSpineFromCfi(book, currDocPage) : null;
        if (spine) {
          return {
            readerType: 'epub',
            spineHref: spine.href,
            spineIndex: spine.index,
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

    // Index manifest rows by their content-stable segmentKey so we can attach
    // their variants to the matching synthesized current-page row. This
    // collapses the visible duplicates (same content showing up twice — once
    // as a synth row with sentence text, once as a manifest row with audio).
    const manifestBySegmentKey = new Map<string, TTSSegmentRow>();
    for (const row of manifestRows) {
      if (row.segmentKey) manifestBySegmentKey.set(row.segmentKey, row);
    }

    const entries: Entry[] = [];
    const claimedManifestKeys = new Set<string>();
    const keyPrefix = buildSegmentKeyPrefix(documentId, activeReaderType);

    // Synthesized rows: one per local sentence. Always tagged as
    // `isCurrentLocation: true` so the live-playback highlight can fire on
    // `currentSentenceIndex`. We compute each sentence's `segmentKey` the same
    // way TTSContext does for persistence; when a manifest row carries the
    // same key, we pull in its variants/audio but keep the locally-resolved
    // per-sentence locator for sort positioning.
    //
    // **Locator preference (drives sort order):**
    //   1. Canonicalized per-sentence locator (`synthRowCanonical[i]`) —
    //      identity-stable with persisted manifest rows across resize and
    //      boundary split variations.
    //   2. Matching manifest row's persisted locator — fallback while the
    //      async resolution is still running.
    //   3. `inferredCurrentLocator` (chapter + 0) — final fallback.
    //
    // Variants/audio are always taken from the manifest match when present,
    // regardless of which locator wins.
    if (inferredCurrentLocator) {
      for (let segmentIndex = 0; segmentIndex < sentences.length; segmentIndex += 1) {
        const sentence = sentences[segmentIndex] ?? '';
        const canonical = synthRowCanonical[segmentIndex] ?? null;
        const segmentKey = canonical?.segmentKey
          ?? (sentence ? buildSegmentKey(keyPrefix, sentence) : null);
        const manifestMatch = segmentKey ? manifestBySegmentKey.get(segmentKey) : undefined;
        if (segmentKey && manifestMatch) claimedManifestKeys.add(segmentKey);

        const localPerSentence = canonical?.locator ?? null;
        const mergedLocator: TTSSegmentLocator =
          localPerSentence
          ?? manifestMatch?.locator
          ?? inferredCurrentLocator;
        const synthRow: TTSSegmentRow = {
          segmentIndex,
          segmentKey,
          locator: mergedLocator,
          variants: manifestMatch?.variants ?? [],
        };
        entries.push({
          segmentIndex,
          sentenceText: sentence,
          row: synthRow,
          isCurrentLocation: true,
          groupKey: locatorGroupKey(mergedLocator),
          groupLabel: formatLocatorGroupLabel(mergedLocator),
          isSynthesized: true,
        });
      }
    }

    // Manifest rows not claimed by a synth row (i.e. content not currently on
    // screen) render as their own listings. They keep their original locator
    // and group, so they sort into their chapter bucket at their real
    // `charOffset` position.
    for (const row of manifestRows) {
      if (row.segmentKey && claimedManifestKeys.has(row.segmentKey)) continue;
      entries.push({
        segmentIndex: row.segmentIndex,
        sentenceText: '',
        row,
        isCurrentLocation: false,
        groupKey: locatorGroupKey(row.locator),
        groupLabel: formatLocatorGroupLabel(row.locator),
        isSynthesized: false,
      });
    }

    entries.sort((a, b) => {
      const byLocator = compareSegmentLocators(a.row.locator, b.row.locator);
      if (byLocator !== 0) return byLocator;
      // Within the same locator group, place synthesized (current-page) rows
      // first so the user's active reading position floats to the top of the
      // chapter group.
      if (a.isSynthesized !== b.isSynthesized) return a.isSynthesized ? -1 : 1;
      return a.segmentIndex - b.segmentIndex;
    });

    return entries;
  }, [manifestData, manifestRows, currDocPage, currDocPageNumber, sentences, epubBookRef, documentId, activeReaderType, synthRowCanonical]);

  const totalVariants = rowsToRender.reduce((sum, r) => sum + r.row.variants.length, 0);

  const hasLoadedManifest = !!manifestData;
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
                  {rowsToRender.map(({ segmentIndex, sentenceText, row, isCurrentLocation, groupKey, groupLabel, isSynthesized }, rowIndex) => {
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
                              <p className={`text-sm leading-snug ${isCurrent ? 'text-foreground' : 'text-soft'} line-clamp-2`}>
                                {sentenceText || (
                                  <span className="text-soft italic text-xs">
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
                              <span className="text-xs text-soft">
                                {formatDuration(activeVariant?.durationMs)}
                              </span>
                              {isCurrent && isPlaying && (
                                <span className="text-xs text-accent font-medium">
                                  playing
                                </span>
                              )}
                              {!canJump && (
                                <span className="text-[10px] text-faint border border-line rounded px-1 py-0.5">
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
                        : `${row.locator.readerType || '?'} (legacy)`}
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
