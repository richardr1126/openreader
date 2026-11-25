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
  // A toggle while the previous one is in flight would race its request
  // (a delete reaching the server before the create it undoes).
  const toggleBusy = create.isPending || remove.isPending;
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
   * existing highlights merges with them into one.
   */
  const highlightRange = useCallback((from: number, to: number) => {
    if (toggleBusy) return;
    const [low, high] = from <= to ? [from, to] : [to, from];
    const overlapping = highlightsOverlapping(highlights, low, high);
    const start = Math.min(low, ...overlapping.map((entry) => entry.start));
    const end = Math.max(high, ...overlapping.map((entry) => entry.end));
    const startSegment = playbackSegments.find((segment) => segment.ordinal === start);
    const endSegment = playbackSegments.find((segment) => segment.ordinal === end);
    if (!startSegment || !endSegment) return;
    // The merged highlight is saved before the ones it replaces are removed,
    // so a failed save leaves them as they were rather than losing them.
    createMutate(highlightInputForSegments({ start: startSegment, end: endSegment, id: crypto.randomUUID() }), {
      onSuccess: () => {
        for (const entry of overlapping) removeMutate(entry.highlight.id);
      },
    });
  }, [createMutate, highlights, playbackSegments, removeMutate, toggleBusy]);

  /** Remove every highlight covering a sentence in `[from, to]`. */
  const unhighlightRange = useCallback((from: number, to: number) => {
    if (toggleBusy) return;
    const [low, high] = from <= to ? [from, to] : [to, from];
    for (const entry of highlightsOverlapping(highlights, low, high)) removeMutate(entry.highlight.id);
  }, [highlights, removeMutate, toggleBusy]);

  return {
    bookmarks,
    highlights,
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
