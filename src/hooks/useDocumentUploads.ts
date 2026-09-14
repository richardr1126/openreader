'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { BaseDocument } from '@/types/documents';
import {
  uploadDocuments as uploadServerDocuments,
  type DocumentUploadProgressEvent,
  type UploadOptions,
} from '@/lib/client/api/documents';
import { cacheStoredDocumentFromBytes } from '@/lib/client/cache/documents';
import {
  createDocumentUploadBatch,
  deriveDocumentUploadSummary,
  documentUploadReducer,
  type DocumentUploadBatch,
  type DocumentUploadSummary,
} from '@/lib/client/uploads/state';

type SupportedDocument = BaseDocument & { type: 'pdf' | 'epub' | 'html' };
type PublicUploadOptions = Pick<UploadOptions, 'folderId' | 'signal'>;

type UploadRuntime = {
  files: File[];
  options?: PublicUploadOptions;
};

const COMPLETION_VISIBILITY_MS = 1_500;

function mergeStoredDocuments(
  previous: SupportedDocument[] | undefined,
  uploaded: BaseDocument[],
): SupportedDocument[] {
  const next = [...(previous ?? [])];

  for (let index = uploaded.length - 1; index >= 0; index -= 1) {
    const stored = uploaded[index];
    if (stored.type !== 'pdf' && stored.type !== 'epub' && stored.type !== 'html') continue;
    const withoutExisting = next.filter((document) => document.id !== stored.id);
    next.splice(0, next.length, stored as SupportedDocument, ...withoutExisting);
  }

  return next;
}

function sourceType(file: File): 'pdf' | 'epub' | 'docx' | 'html' {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (lowerName.endsWith('.epub') || file.type === 'application/epub+zip') return 'epub';
  if (
    lowerName.endsWith('.docx')
    || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) return 'docx';
  return 'html';
}

function createBatchId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The document upload failed';
}

async function cacheUploadedFiles(files: File[], stored: BaseDocument[]): Promise<void> {
  for (let index = 0; index < stored.length; index += 1) {
    const document = stored[index];
    const file = files[index];
    if (!document || !file || document.type !== sourceType(file)) continue;
    try {
      await cacheStoredDocumentFromBytes(document, await file.arrayBuffer());
    } catch {
      // The server copy is authoritative; a browser cache failure is non-fatal.
    }
  }
}

function remapProgressEvent(
  event: DocumentUploadProgressEvent,
  sourceIndexes: number[],
): DocumentUploadProgressEvent | null {
  if (!('sourceIndex' in event)) return event;
  const sourceIndex = sourceIndexes[event.sourceIndex];
  return sourceIndex === undefined ? null : { ...event, sourceIndex };
}

export type DocumentUploadsController = {
  uploadDocuments: (files: File[], options?: PublicUploadOptions) => Promise<BaseDocument[]>;
  uploadSummary: DocumentUploadSummary | null;
  cancelUploads: () => void;
  retryFailedUploads: () => void;
  dismissUploadStatus: () => void;
};

export function useDocumentUploads(documentsQueryKey: QueryKey): DocumentUploadsController {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(documentUploadReducer, { batches: [] });
  const runtimesRef = useRef(new Map<string, UploadRuntime>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const completionTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const runBatch = useCallback(async (
    batch: DocumentUploadBatch,
    runtime: UploadRuntime,
    sourceIndexes = runtime.files.map((_, index) => index),
  ): Promise<BaseDocument[]> => {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(runtime.options?.signal?.reason);
    runtime.options?.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (runtime.options?.signal?.aborted) forwardAbort();
    controllersRef.current.set(batch.id, controller);
    const files = sourceIndexes.flatMap((index) => {
      const file = runtime.files[index];
      return file ? [file] : [];
    });
    if (files.length !== sourceIndexes.length) {
      throw new Error('The upload retry no longer matches its original files');
    }

    try {
      const stored = await uploadServerDocuments(files, {
        folderId: runtime.options?.folderId,
        signal: controller.signal,
        onProgress: (event) => {
          const mappedEvent = remapProgressEvent(event, sourceIndexes);
          if (mappedEvent) dispatch({ type: 'progress', batchId: batch.id, event: mappedEvent });
        },
      });
      queryClient.setQueryData<SupportedDocument[]>(documentsQueryKey, (previous) =>
        mergeStoredDocuments(previous, stored),
      );
      await cacheUploadedFiles(files, stored);
      dispatch({ type: 'progress', batchId: batch.id, event: { phase: 'complete' } });
      runtimesRef.current.delete(batch.id);

      const timer = setTimeout(() => {
        dispatch({ type: 'remove', batchId: batch.id });
        completionTimersRef.current.delete(batch.id);
      }, COMPLETION_VISIBILITY_MS);
      completionTimersRef.current.set(batch.id, timer);
      return stored;
    } catch (error) {
      if (controller.signal.aborted) {
        dispatch({ type: 'remove', batchId: batch.id });
        runtimesRef.current.delete(batch.id);
      } else {
        dispatch({ type: 'failed', batchId: batch.id, error: errorMessage(error) });
      }
      throw error;
    } finally {
      runtime.options?.signal?.removeEventListener('abort', forwardAbort);
      controllersRef.current.delete(batch.id);
      void queryClient.invalidateQueries({ queryKey: documentsQueryKey });
    }
  }, [documentsQueryKey, queryClient]);

  const uploadDocuments = useCallback(async (
    files: File[],
    options?: PublicUploadOptions,
  ): Promise<BaseDocument[]> => {
    if (files.length === 0) return [];
    const batch = createDocumentUploadBatch(createBatchId(), files, options?.folderId);
    const runtime = { files, options };
    runtimesRef.current.set(batch.id, runtime);
    dispatch({ type: 'add', batch });
    return runBatch(batch, runtime);
  }, [runBatch]);

  const cancelUploads = useCallback(() => {
    for (const controller of controllersRef.current.values()) {
      controller.abort(new DOMException('Document upload cancelled', 'AbortError'));
    }
  }, []);

  const retryFailedUploads = useCallback(() => {
    const failedBatches = state.batches.filter((batch) =>
      batch.tasks.some((task) => task.phase === 'failed'),
    );
    for (const batch of failedBatches) {
      const runtime = runtimesRef.current.get(batch.id);
      if (!runtime) continue;
      const sourceIndexes = batch.tasks.flatMap((task, index) => task.phase === 'failed' ? [index] : []);
      dispatch({ type: 'retry', batchId: batch.id, sourceIndexes, startedAt: Date.now() });
      void runBatch(batch, runtime, sourceIndexes).catch(() => {
        // runBatch keeps the retryable failure in the shared upload state.
      });
    }
  }, [runBatch, state.batches]);

  const dismissUploadStatus = useCallback(() => {
    const terminalIds = state.batches
      .filter((batch) => batch.tasks.every((task) => task.phase === 'complete' || task.phase === 'failed'))
      .map((batch) => batch.id);
    for (const id of terminalIds) {
      const timer = completionTimersRef.current.get(id);
      if (timer) clearTimeout(timer);
      completionTimersRef.current.delete(id);
      runtimesRef.current.delete(id);
    }
    dispatch({ type: 'remove-terminal' });
  }, [state.batches]);

  useEffect(() => () => {
    for (const controller of controllersRef.current.values()) controller.abort();
    for (const timer of completionTimersRef.current.values()) clearTimeout(timer);
    controllersRef.current.clear();
    completionTimersRef.current.clear();
    runtimesRef.current.clear();
  }, []);

  return {
    uploadDocuments,
    uploadSummary: useMemo(() => deriveDocumentUploadSummary(state), [state]),
    cancelUploads,
    retryFailedUploads,
    dismissUploadStatus,
  };
}
