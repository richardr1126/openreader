'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useTTS } from '@/contexts/TTSContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  createDocumentBookmark,
  deleteDocumentBookmark,
  listDocumentBookmarks,
  renameDocumentBookmark,
} from '@/lib/client/api/bookmarks';
import { queryKeys } from '@/lib/client/query-keys';
import {
  bookmarkInputForSegment,
  findBookmarkForSegment,
  highlightInputForSegments,
  highlightsOverlapping,
  mergeHighlightRange,
  resolveHighlights,
} from '@/lib/client/reader/bookmarks';
import { isHighlight, type CreateDocumentBookmarkInput, type DocumentBookmark } from '@/types/bookmarks';

function isHighlightInput(input: CreateDocumentBookmarkInput): boolean {
  return input.endSegmentOrdinal !== undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The document's bookmarks (newest first), its highlights (in reading order)
 * and the bookmark on the current playback sentence. Both live in one cache
 * entry that every reader and panel share; mutations update it optimistically
 * and roll back on failure.
 */
export function useDocumentBookmarks(documentId: string) {
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = queryKeys.documentBookmarks(sessionId, documentId);
  const queryClient = useQueryClient();
  const { playbackSegments, currentSentenceOrdinal } = useTTS();

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listDocumentBookmarks(documentId, { signal }),
    enabled: !isPending && Boolean(documentId),
  });
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const bookmarks = useMemo(() => rows.filter((row) => !isHighlight(row)), [rows]);
  const highlights = useMemo(() => resolveHighlights(playbackSegments, rows), [playbackSegments, rows]);
  // Saved highlights the current text can't place (still preparing, or re-planned).
  const unplacedHighlights = rows.filter(isHighlight).length - highlights.length;

  const snapshot = useCallback(async () => {
    await queryClient.cancelQueries({ queryKey: key });
    return queryClient.getQueryData<DocumentBookmark[]>(key);
  }, [key, queryClient]);
  const restore = (_error: unknown, _input: unknown, context: { previous?: DocumentBookmark[] } | undefined) => {
    queryClient.setQueryData(key, context?.previous);
  };
  const settle = () => queryClient.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: (input: CreateDocumentBookmarkInput) => createDocumentBookmark(documentId, input),
    onMutate: async (input) => {
      const previous = await snapshot();
      const now = Date.now();
      const optimistic: DocumentBookmark = {
        ...input,
        id: input.id ?? '',
        documentId,
        label: input.label ?? null,
        endSegmentKey: input.endSegmentKey ?? null,
        endSegmentOrdinal: input.endSegmentOrdinal ?? null,
        createdAtMs: now,
        updatedAtMs: now,
      };
      queryClient.setQueryData<DocumentBookmark[]>(key, (rows = []) => [optimistic, ...rows]);
      return { previous };
    },
    onError: (error, input, context) => {
      restore(error, input, context);
      toast.error(errorMessage(error, isHighlightInput(input) ? 'Failed to add highlight' : 'Failed to add bookmark'));
    },
    onSettled: settle,
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; label: string | null }) => renameDocumentBookmark(documentId, input.id, input.label),
    onMutate: async (input) => {
      const previous = await snapshot();
      const label = input.label?.trim() || null;
      queryClient.setQueryData<DocumentBookmark[]>(key, (rows = []) => rows.map((row) => (
        row.id === input.id ? { ...row, label } : row
      )));
      return { previous };
    },
    onError: (error, input, context) => {
      restore(error, input, context);
      toast.error(errorMessage(error, 'Failed to rename bookmark'));
    },
    onSettled: settle,
  });

  // One operation, so the rows a merge replaces are removed even if the reader
  // closes before the new row is saved. The new row is saved first: a failed
  // save leaves the originals as they were.
  const merge = useMutation({
    mutationFn: async ({ input, replaced }: { input: CreateDocumentBookmarkInput; replaced: string[] }) => {
      const created = await createDocumentBookmark(documentId, input);
      // Every replaced row is tried, so one failure leaves no others behind.
      const deleted = await Promise.allSettled(replaced.map((id) => deleteDocumentBookmark(documentId, id)));
      const failed = deleted.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      return created;
    },
    onMutate: async ({ input, replaced }) => {
      const previous = await snapshot();
      const now = Date.now();
      const optimistic: DocumentBookmark = {
        ...input,
        id: input.id ?? '',
        documentId,
        label: input.label ?? null,
        endSegmentKey: input.endSegmentKey ?? null,
        endSegmentOrdinal: input.endSegmentOrdinal ?? null,
        createdAtMs: now,
        updatedAtMs: now,
      };
      queryClient.setQueryData<DocumentBookmark[]>(key, (rows = []) => [
        optimistic,
        ...rows.filter((row) => !replaced.includes(row.id)),
      ]);
      return { previous };
    },
    onError: (error, input, context) => {
      restore(error, input, context);
      toast.error(errorMessage(error, 'Failed to save highlight'));
    },
    onSettled: settle,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteDocumentBookmark(documentId, id),
    onMutate: async (id) => {
      const previous = await snapshot();
      queryClient.setQueryData<DocumentBookmark[]>(key, (rows = []) => rows.filter((row) => row.id !== id));
      return { previous };
    },
    onError: (error, id, context) => {
      restore(error, id, context);
      toast.error(errorMessage(error, 'Failed to delete'));
    },
    onSettled: settle,
  });

  const currentSegment = useMemo(
    () => (currentSentenceOrdinal === null
      ? null
      : playbackSegments.find((segment) => segment.ordinal === currentSentenceOrdinal) ?? null),
    [currentSentenceOrdinal, playbackSegments],
  );
  const currentBookmark = findBookmarkForSegment(bookmarks, currentSegment);

  const { mutate: createMutate } = create;
  const { mutate: removeMutate } = remove;
  const { mutate: mergeMutate } = merge;
  // A toggle while the previous one is in flight would race its request
  // (a delete reaching the server before the create it undoes).
  const toggleBusy = create.isPending || remove.isPending || merge.isPending;
  // Until the saved rows have loaded, a range can't be merged with them.
  const rangeBusy = toggleBusy || !query.isSuccess;
  const toggleCurrent = useCallback(() => {
    if (toggleBusy) return;
    if (currentBookmark) {
      removeMutate(currentBookmark.id);
      return;
    }
    if (!currentSegment) return;
    createMutate(bookmarkInputForSegment({ segment: currentSegment, id: crypto.randomUUID() }));
  }, [createMutate, currentBookmark, currentSegment, removeMutate, toggleBusy]);

  const isCurrentBookmarked = Boolean(currentBookmark);
  const sentenceBookmark = useMemo(() => ({
    isBookmarked: isCurrentBookmarked,
    canToggle: isCurrentBookmarked || currentSegment !== null,
    onToggle: toggleCurrent,
  }), [currentSegment, isCurrentBookmarked, toggleCurrent]);

  /**
   * Highlight the sentences from `from` through `to`. A range that overlaps
   * existing highlights merges with them into one. False when it can't be
   * taken yet, so the caller keeps the reader's selection.
   */
  const highlightRange = useCallback((from: number, to: number): boolean => {
    if (rangeBusy) return false;
    const { start, end, absorbed, label } = mergeHighlightRange(highlights, from, to);
    const startSegment = playbackSegments.find((segment) => segment.ordinal === start);
    const endSegment = playbackSegments.find((segment) => segment.ordinal === end);
    if (!startSegment || !endSegment) return false;
    const input = highlightInputForSegments({ start: startSegment, end: endSegment, id: crypto.randomUUID() });
    mergeMutate({ input: label ? { ...input, label } : input, replaced: absorbed.map((entry) => entry.highlight.id) });
    return true;
  }, [highlights, mergeMutate, playbackSegments, rangeBusy]);

  /** Remove every highlight covering a sentence in `[from, to]`. False when it can't be taken yet. */
  const unhighlightRange = useCallback((from: number, to: number): boolean => {
    if (rangeBusy) return false;
    const [low, high] = from <= to ? [from, to] : [to, from];
    for (const entry of highlightsOverlapping(highlights, low, high)) removeMutate(entry.highlight.id);
    return true;
  }, [highlights, rangeBusy, removeMutate]);

  return {
    bookmarks,
    highlights,
    unplacedHighlights,
    highlightRange,
    unhighlightRange,
    isLoading: isPending || query.isPending,
    isError: query.isError,
    /** The header toggle for the current playback sentence. */
    sentenceBookmark,
    rename: rename.mutate,
    remove: removeMutate,
  };
}
