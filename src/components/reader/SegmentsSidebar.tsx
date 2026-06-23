'use client';

import { Fragment, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import { Transition } from '@headlessui/react';
import { useMutation } from '@tanstack/react-query';
import type { Book } from 'epubjs';
import toast from 'react-hot-toast';
import { useTTS } from '@/contexts/TTSContext';
import { InfoIcon } from '@/components/icons/Icons';
import { Button, PopoverIconTrigger, PopoverRoot, PopoverSurface } from '@/components/ui';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { compareSegmentLocators, locatorGroupKey } from '@openreader/tts/locator';
import { resolveSpineFromCfi } from '@/lib/client/epub/spine-coordinates';
import {
  isHtmlLocator,
  isPdfLocator,
  isStableEpubLocator,
} from '@/types/client';
import type {
  TTSSegmentLocator,
} from '@/types/client';

interface SegmentsSidebarProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  documentId: string;
  epubBookRef?: RefObject<Book | null>;
}

type ClearSegmentsPayload = {
  error?: string;
  deletedSegments?: number;
  requestedAudioObjects?: number;
  deletedAudioObjects?: number;
  invalidatedPlaybackSessions?: number;
  warning?: string;
};

type SegmentPlaybackStatus = {
  segmentId: string;
  durationMs: number | null;
  status: 'pending' | 'completed' | 'error';
  alignmentWordCount: number;
};

type SidebarSegmentRow = {
  segmentIndex: number;
  segmentKey: string | null;
  locator: TTSSegmentLocator | null;
  playbackStatus: SegmentPlaybackStatus | null;
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

function statusColor(status: SegmentPlaybackStatus['status']): string {
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
  const {
    sentences,
    playbackSegments,
    playbackPlanSource,
    playbackSeekLayout,
    currentSentenceIndex,
    currDocPage,
    currDocPageNumber,
    isPlaying,
    playFromSegment,
    activeReaderType,
    clearSegmentCaches,
  } = useTTS();

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
        .map<SynthItem | null>((segment) => {
          const locator = segment.ownerLocator;
          if (!isStableEpubLocator(locator)) return null;
          if (
            locator.spineIndex !== currentEpubSpine.index
            || locator.spineHref !== currentEpubSpine.href
          ) {
            return null;
          }
          return {
            segmentIndex: segment.ordinal,
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
      if (activeReaderType === 'pdf') {
        const locator = segment.ownerLocator;
        if (!isPdfLocator(locator)) return null;
        const currentPage = Math.max(1, Math.floor(Number(currDocPageNumber)));
        if (!Number.isFinite(currentPage) || Math.floor(locator.page) !== currentPage) return null;
      }
      return {
        segmentIndex: segment.ordinal,
        text,
        segmentKey: segment.key ?? null,
        locator: segment.ownerLocator ?? null,
      };
    }).filter((item): item is SynthItem => item !== null);
  }, [activeReaderType, currDocPageNumber, currentEpubSpine, playbackPlanSource, playbackSegments, sentences]);

  const visiblePlanItems = useMemo(() => {
    if (activeReaderType !== 'epub' || currentEpubSpine) return sidebarSynthItems;
    return [];
  }, [activeReaderType, currentEpubSpine, sidebarSynthItems]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const didAutoScrollOnOpenRef = useRef(false);
  const userScrollUntilMsRef = useRef(0);
  const programmaticScrollUntilMsRef = useRef(0);

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
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to clear segments cache');
    },
  });
  const { mutateAsync: clearSegments, isPending: isClearingSegments } = clearSegmentsMutation;

  const handleClearCache = useCallback(async () => {
    if (!documentId || isClearingSegments) return;
    const confirmed = window.confirm('Clear cached segments for this document version? This removes stored segment metadata and audio objects.');
    if (!confirmed) return;
    await clearSegments();
  }, [documentId, isClearingSegments, clearSegments]);

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
  }, [isOpen]);

  const handleJump = useCallback((index: number, locator: TTSSegmentLocator | null) => {
    playFromSegment(index, locator);
  }, [playFromSegment]);

  const rowsToRender = useMemo(() => {
    type Entry = {
      segmentIndex: number;
      displayIndex: number;
      sentenceText: string;
      row: SidebarSegmentRow;
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

    const entries: Entry[] = [];
    const statusByOrdinal = new Map<number, SegmentPlaybackStatus>();
    for (const segment of playbackSeekLayout?.segments ?? []) {
      if (!segment.segmentId) continue;
      const status: SegmentPlaybackStatus['status'] = segment.audioState === 'ready' || segment.generated
        ? 'completed'
        : segment.audioState === 'error'
          ? 'error'
          : 'pending';
      if (status !== 'completed' && status !== 'error') continue;
      statusByOrdinal.set(segment.ordinal, {
        segmentId: segment.segmentId,
        durationMs: segment.durationMs,
        status,
        alignmentWordCount: segment.alignment?.words?.length ?? 0,
      });
    }

    for (let rowIndex = 0; rowIndex < visiblePlanItems.length; rowIndex += 1) {
      const item = visiblePlanItems[rowIndex]!;
      const segmentKey = item.segmentKey;
      const rowLocator = item.locator ?? inferredCurrentLocator;
      if (!rowLocator) continue;
      const row: SidebarSegmentRow = {
        segmentIndex: item.segmentIndex,
        segmentKey,
        locator: rowLocator,
        playbackStatus: statusByOrdinal.get(item.segmentIndex) ?? null,
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
  }, [currDocPage, currDocPageNumber, visiblePlanItems, currentEpubSpine, activeReaderType, playbackSeekLayout]);

  const readySegments = rowsToRender.filter((r) => r.row.playbackStatus?.status === 'completed').length;

  const hasLoadedSegments = playbackPlanSource === 'worker';

  useEffect(() => {
    if (!isOpen) {
      didAutoScrollOnOpenRef.current = false;
      return;
    }
    if (didAutoScrollOnOpenRef.current) return;
    if (!hasLoadedSegments || rowsToRender.length === 0) return;

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
  }, [isOpen, hasLoadedSegments, rowsToRender.length, currentSentenceIndex]);

  useEffect(() => {
    if (!isOpen || !isPlaying) return;
    if (!hasLoadedSegments || rowsToRender.length === 0) return;

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
    hasLoadedSegments,
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
    </>
  );

  return (
    <ReaderSidebarShell
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      ariaLabel="TTS segments"
      title="Segments"
      subtitle="Click an index or sentence to jump."
      headerActions={headerActions}
      bodyClassName="flex-1 overflow-y-auto px-0 py-0"
    >
      <div className="px-4 py-2 border-b border-line-soft">
        <div className="text-xs text-soft">
          {hasLoadedSegments ? (
            <>
              {rowsToRender.length} indexed
              <span> · </span>
              {readySegments} ready
            </>
          ) : (
            <span>—</span>
          )}
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto">
              {hasLoadedSegments && rowsToRender.length === 0 && (
                <div className="px-4 py-10 flex flex-col items-center text-center gap-2">
                  <div className="text-sm font-medium text-soft">
                    No segments
                  </div>
                  <p className="text-sm text-soft leading-relaxed max-w-[24ch]">
                    Press play in the reader to generate audio segments.
                  </p>
                </div>
              )}
              {hasLoadedSegments && rowsToRender.length > 0 && (
                <ul className="divide-y divide-line-soft">
                  {rowsToRender.map(({ segmentIndex, displayIndex, sentenceText, row, isCurrentLocation, groupKey, groupLabel, isSynthesized }, rowIndex) => {
                    const previousGroupKey = rowIndex > 0 ? rowsToRender[rowIndex - 1]?.groupKey : null;
                    const showGroupHeader = previousGroupKey !== groupKey;
                    const isCurrent = isPlaying && isCurrentLocation && segmentIndex === currentSentenceIndex;
                    const playbackStatus = row.playbackStatus;
                    const status = playbackStatus?.status ?? 'pending';
                    const canJump = !!row.locator || sentenceText.length > 0;
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
                            title="Jump to this segment"
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
                                {formatDuration(playbackStatus?.durationMs)}
                              </span>
                              {isCurrent && isPlaying && (
                                <span className="text-xs text-accent font-medium">
                                  playing
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
      </div>
    </ReaderSidebarShell>
  );
}

function SegmentMetadataPopover({ row }: { row: SidebarSegmentRow }) {
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
            <Row label="status">
              <span className="font-mono text-[10px] text-foreground">
                {row.playbackStatus?.status ?? 'pending'}
              </span>
            </Row>
            {row.playbackStatus && (
              <div className="border-t border-line-soft pt-2">
                <Row label="segment_id">
                  <span className="font-mono text-[10px] text-soft break-all">
                    {row.playbackStatus.segmentId.slice(0, 16)}...
                  </span>
                </Row>
                <Row label="duration">
                  <span className="font-mono tabular-nums text-[10px] text-foreground">
                    {formatDuration(row.playbackStatus.durationMs)}
                  </span>
                </Row>
                <Row label="alignment">
                  <span className="font-mono tabular-nums text-[10px] text-foreground">
                    {row.playbackStatus.alignmentWordCount} words
                  </span>
                </Row>
              </div>
            )}
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
