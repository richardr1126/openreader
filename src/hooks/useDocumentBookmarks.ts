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
import { bookmarkInputForSegment, findBookmarkForSegment } from '@/lib/client/reader/bookmarks';
import type { CreateDocumentBookmarkInput, DocumentBookmark } from '@/types/bookmarks';
import type { ReaderType } from '@/types/user-state';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The document's bookmarks (newest first) and the bookmark on the current
 * playback sentence. Mutations update the list optimistically and roll back
 * on failure; every reader and the bookmarks panel share one cache entry.
 */
export function useDocumentBookmarks(documentId: string, readerType: ReaderType) {
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = queryKeys.documentBookmarks(sessionId, documentId);
  const queryClient = useQueryClient();
  const { playbackSegments, currentSentenceOrdinal, currDocPage } = useTTS();

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listDocumentBookmarks(documentId, { signal }),
    enabled: !isPending && Boolean(documentId),
  });
  const bookmarks = useMemo(() => query.data ?? [], [query.data]);

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
      const optimistic = {
        ...input,
        id: input.id ?? '',
        documentId,
        label: input.label ?? null,
        segmentKey: input.segmentKey ?? null,
        segmentOrdinal: input.segmentOrdinal ?? null,
        createdAtMs: now,
        updatedAtMs: now,
      } as DocumentBookmark;
      queryClient.setQueryData<DocumentBookmark[]>(key, (rows = []) => [optimistic, ...rows]);
      return { previous };
    },
    onError: (error, input, context) => {
      restore(error, input, context);
      toast.error(errorMessage(error, 'Failed to add bookmark'));
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
      toast.error(errorMessage(error, 'Failed to delete bookmark'));
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
  const currentInput = useMemo(() => (currentSegment
    ? bookmarkInputForSegment({ readerType, segment: currentSegment, currentLocation: currDocPage, id: '' })
    : null), [currDocPage, currentSegment, readerType]);

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
    if (!currentInput) return;
    createMutate({ ...currentInput, id: crypto.randomUUID() });
  }, [createMutate, currentBookmark, currentInput, removeMutate, toggleBusy]);

  const isCurrentBookmarked = Boolean(currentBookmark);
  const sentenceBookmark = useMemo(() => ({
    isBookmarked: isCurrentBookmarked,
    canToggle: isCurrentBookmarked || currentInput !== null,
    onToggle: toggleCurrent,
  }), [currentInput, isCurrentBookmarked, toggleCurrent]);

  return {
    bookmarks,
    isLoading: isPending || query.isPending,
    isError: query.isError,
    /** The header toggle for the current playback sentence. */
    sentenceBookmark,
    rename: rename.mutate,
    remove: removeMutate,
  };
}
