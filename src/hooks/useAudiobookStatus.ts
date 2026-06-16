'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteAudiobook,
  deleteAudiobookChapter,
  getAudiobookStatus,
} from '@/lib/client/api/audiobooks';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import type { AudiobookStatusResponse } from '@/types/client';
import type { TTSAudiobookChapter } from '@/types/tts';

const emptyStatus = (): AudiobookStatusResponse => ({
  exists: false,
  chapters: [],
  bookId: null,
  hasComplete: false,
  settings: null,
});

export function useAudiobookStatus(documentId: string, enabled = true) {
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = useMemo(() => queryKeys.audiobook(sessionId, documentId), [documentId, sessionId]);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getAudiobookStatus(documentId, signal),
    enabled: enabled && !isSessionPending && Boolean(documentId),
  });

  const setChapter = useCallback((chapter: TTSAudiobookChapter) => {
    queryClient.setQueryData<AudiobookStatusResponse>(key, (current = emptyStatus()) => {
      const chapters = current.chapters.some((item) => item.index === chapter.index)
        ? current.chapters.map((item) => item.index === chapter.index ? chapter : item)
        : [...current.chapters, chapter].sort((a, b) => a.index - b.index);
      return {
        ...current,
        exists: true,
        bookId: chapter.bookId ?? current.bookId,
        chapters,
      };
    });
  }, [key, queryClient]);

  const deleteChapterMutation = useMutation({
    mutationFn: ({ bookId, chapterIndex }: { bookId: string; chapterIndex: number }) =>
      deleteAudiobookChapter(bookId, chapterIndex),
    onMutate: async ({ chapterIndex }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AudiobookStatusResponse>(key);
      queryClient.setQueryData<AudiobookStatusResponse>(key, (current = emptyStatus()) => ({
        ...current,
        chapters: current.chapters.filter((chapter) => chapter.index !== chapterIndex),
      }));
      return { previous };
    },
    onError: (_error, _input, context) => queryClient.setQueryData(key, context?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const resetMutation = useMutation({
    mutationFn: (bookId: string) => deleteAudiobook(bookId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AudiobookStatusResponse>(key);
      queryClient.setQueryData(key, emptyStatus());
      return { previous };
    },
    onError: (_error, _bookId, context) => queryClient.setQueryData(key, context?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: key }),
    [key, queryClient],
  );

  return {
    query,
    setChapter,
    deleteChapterMutation,
    resetMutation,
    invalidate,
  };
}
