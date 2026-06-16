'use client';

import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ensureParsedPdfDocumentOperation,
  forceReparsePdfDocument,
  getParsedPdfDocument,
  ParsedPdfNotReadyError,
  subscribeParsedPdfDocumentEvents,
} from '@/lib/client/api/documents';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import type { ParsedPdfDocument, PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';

export type ParsedPdfQueryState = {
  document: ParsedPdfDocument | null;
  parseStatus: PdfParseStatus;
  parseProgress: PdfParseProgress | null;
  opId: string | null;
  error?: string | null;
};

function pendingState(input: {
  parseStatus: PdfParseStatus;
  parseProgress: PdfParseProgress | null;
  opId: string | null;
  error?: string | null;
}): ParsedPdfQueryState {
  return { document: null, ...input };
}

async function resolveParsedPdfState(documentId: string, signal?: AbortSignal): Promise<ParsedPdfQueryState> {
  try {
    const document = await getParsedPdfDocument(documentId, { signal });
    return { document, parseStatus: 'ready', parseProgress: null, opId: null };
  } catch (error) {
    if (!(error instanceof ParsedPdfNotReadyError)) throw error;
    if (error.parseStatus === 'failed' || error.opId) {
      return pendingState({
        parseStatus: error.parseStatus,
        parseProgress: error.parseProgress,
        opId: error.opId,
        error: error.details,
      });
    }
    const ensured = await ensureParsedPdfDocumentOperation(documentId, { signal });
    if (ensured.parseStatus === 'ready') {
      const document = await getParsedPdfDocument(documentId, { signal });
      return { document, parseStatus: 'ready', parseProgress: null, opId: null };
    }
    return pendingState(ensured);
  }
}

const MAX_READY_ARTIFACT_ATTEMPTS = 8;

async function loadReadyArtifact(documentId: string, signal: AbortSignal): Promise<ParsedPdfDocument> {
  let retryMs = 500;
  let attempts = 0;
  while (!signal.aborted) {
    try {
      return await getParsedPdfDocument(documentId, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      attempts += 1;
      // Bound retries so a persistent server error after the ready event cannot
      // turn into an endless polling loop; let the hook state settle instead.
      if (attempts >= MAX_READY_ARTIFACT_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 2_000);
    }
  }
  throw new DOMException('Aborted', 'AbortError');
}

export function useParsedPdfDocument(documentId: string | undefined) {
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = useMemo(
    () => queryKeys.parsedDocument(sessionId, documentId ?? ''),
    [documentId, sessionId],
  );
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => resolveParsedPdfState(documentId!, signal),
    enabled: !isSessionPending && Boolean(documentId),
    retry: false,
  });

  const state = query.data;
  useEffect(() => {
    if (!documentId || !state?.opId || (state.parseStatus !== 'pending' && state.parseStatus !== 'running')) return;
    const controller = new AbortController();
    let isResolvingReadyArtifact = false;
    const close = subscribeParsedPdfDocumentEvents(documentId, { opId: state.opId }, {
      onSnapshot: (snapshot) => {
        if (controller.signal.aborted) return;
        if (snapshot.parseStatus === 'ready') {
          if (isResolvingReadyArtifact) return;
          isResolvingReadyArtifact = true;
          void loadReadyArtifact(documentId, controller.signal).then((document) => {
            if (controller.signal.aborted) return;
            queryClient.setQueryData<ParsedPdfQueryState>(key, {
              document,
              parseStatus: 'ready',
              parseProgress: null,
              opId: null,
            });
            void queryClient.invalidateQueries({ queryKey: key });
            close();
          }).catch((error) => {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
              console.error('Failed to load ready parsed PDF artifact:', error);
            }
          });
          return;
        }
        queryClient.setQueryData<ParsedPdfQueryState>(key, (current) => pendingState({
          parseStatus: snapshot.parseStatus,
          parseProgress: snapshot.parseProgress,
          opId: snapshot.opId?.trim() || current?.opId || null,
          error: snapshot.error ?? null,
        }));
        if (snapshot.parseStatus === 'failed') {
          void queryClient.invalidateQueries({ queryKey: key });
          close();
        }
      },
      onError: () => {
        if (!controller.signal.aborted) {
          console.warn('[pdf] parsed/events stream error; waiting for auto-reconnect', { documentId });
        }
      },
    });
    return () => {
      controller.abort();
      close();
    };
  }, [documentId, key, queryClient, state?.opId, state?.parseStatus]);

  const forceReparseMutation = useMutation({
    mutationFn: () => forceReparsePdfDocument(documentId!),
    onSuccess: (forced) => {
      queryClient.setQueryData<ParsedPdfQueryState>(key, pendingState({
        parseStatus: forced.status,
        parseProgress: null,
        opId: forced.opId?.trim() || null,
      }));
    },
  });

  return { query, forceReparseMutation };
}
