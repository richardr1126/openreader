import type { BaseDocument, DocumentType } from '@/types/documents';
import type { DocumentSettings } from '@/types/document-settings';
import type { DocumentResource, DocumentUploadResource, PreparedDocumentUpload } from '@/types/document-api';
import type { ReaderBootstrapRestart } from '@/types/reader-bootstrap';
import { parseApiError } from '@/lib/client/api/http';
import { transferPreparedDocumentUploads } from '@/lib/client/uploads/transfer';

export type UploadSource = {
  name: string;
  type: DocumentType;
  size: number;
  lastModified: number;
  contentType: string;
  body: Blob | ArrayBuffer | Uint8Array;
  metadata?: DocumentImportMetadata;
};

/** Hints the server prefers over metadata it reads from the file itself. */
export type DocumentImportMetadata = {
  author?: string | null;
  language?: string | null;
};

export type DocumentUploadProgressEvent =
  | { phase: 'preparing' }
  | { phase: 'transferring'; sourceIndex: number; loadedBytes: number; totalBytes: number }
  | { phase: 'source-complete'; sourceIndex: number }
  | { phase: 'finalizing' }
  | {
      phase: 'processing';
      sourceIndex: number;
      operationStatus: 'queued' | 'running';
      workerPhase?: 'fetching' | 'converting' | 'uploading';
    }
  | { phase: 'complete' };

export type UploadOptions = {
  signal?: AbortSignal;
  folderId?: string;
  onProgress?: (event: DocumentUploadProgressEvent) => void;
};

const DOCUMENT_CONVERSION_TIMEOUT_MS = 5 * 60 * 1000;

export class DocumentConversionPendingError extends Error {
  constructor(readonly uploads: DocumentUploadResource[]) {
    super('DOCX conversion is still running');
    this.name = 'DocumentConversionPendingError';
  }
}

function waitForDocumentConversion(upload: DocumentUploadResource, sourceIndex: number, onProgress?: UploadOptions['onProgress'], signal?: AbortSignal): Promise<void> {
  if (!upload.eventsUrl) return Promise.reject(new Error('Conversion did not provide an event stream.'));
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const source = new EventSource(upload.eventsUrl!);
    const cleanup = () => { clearTimeout(timeout); source.close(); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal?.reason); };
    const timeout = setTimeout(() => { cleanup(); reject(new DocumentConversionPendingError([upload])); }, DOCUMENT_CONVERSION_TIMEOUT_MS);
    source.addEventListener('snapshot', event => {
      try {
        const snapshot = JSON.parse((event as MessageEvent<string>).data).snapshot as {
          status: 'queued' | 'running' | 'succeeded' | 'failed'; error?: { message?: string };
          progress?: { phase?: 'fetching' | 'converting' | 'uploading' };
        };
        if (snapshot.status === 'succeeded') { cleanup(); resolve(); }
        else if (snapshot.status === 'failed') { cleanup(); reject(new Error(snapshot.error?.message || 'Document conversion failed.')); }
        else onProgress?.({ phase: 'processing', sourceIndex, operationStatus: snapshot.status, workerPhase: snapshot.progress?.phase });
      } catch { /* A malformed frame must not replace valid operation state. */ }
    });
    // A closed stream will not reconnect, so the caller reads the current status instead.
    source.onerror = () => { if (source.readyState === EventSource.CLOSED) { cleanup(); resolve(); } };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function finalizeUploadedSources(uploads: Array<{ id: string; name: string }>, options?: UploadOptions): Promise<BaseDocument[]> {
  options?.onProgress?.({ phase: 'finalizing' });
  const stored = await Promise.all(uploads.map(async (upload, sourceIndex) => {
    const response = await fetch('/api/v1/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { type: 'upload', uploadId: upload.id }, ...(options?.folderId ? { folderId: options.folderId } : {}) }), signal: options?.signal });
    if (!response.ok) throw await parseApiError(response, 'Failed to create document');
    let document: BaseDocument;
    if (response.status === 202) {
      let pending = await response.json() as DocumentUploadResource;
      if (pending.status === 'failed') throw new Error(pending.error || 'Document conversion failed.');
      options?.onProgress?.({ phase: 'processing', sourceIndex, operationStatus: 'queued' });
      await waitForDocumentConversion(pending, sourceIndex, options?.onProgress, options?.signal);
      const status = await fetch(pending.statusUrl, { signal: options?.signal, cache: 'no-store' });
      if (!status.ok) throw await parseApiError(status, 'Failed to finish document conversion');
      pending = await status.json() as DocumentUploadResource;
      if (!pending.document) {
        if (pending.status === 'failed') throw new Error(pending.error || 'Document conversion failed.');
        throw new DocumentConversionPendingError([pending]);
      }
      document = pending.document;
    } else document = await response.json() as DocumentResource;
    options?.onProgress?.({ phase: 'source-complete', sourceIndex });
    return document;
  }));
  options?.onProgress?.({ phase: 'complete' });
  return stored;
}

function documentTypeForName(name: string): DocumentType {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.epub')) return 'epub';
  if (lower.endsWith('.docx')) return 'docx';
  return 'html';
}

function documentTypeForMime(contentType: string): DocumentType | null {
  const normalized = contentType.trim().toLowerCase();
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized === 'application/epub+zip') return 'epub';
  if (normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  return null;
}

export function mimeTypeForDoc(doc: Pick<BaseDocument, 'type' | 'name'>): string {
  if (doc.type === 'pdf') return 'application/pdf';
  if (doc.type === 'epub') return 'application/epub+zip';
  if (doc.type === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const lower = doc.name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdown') || lower.endsWith('.mkd')) {
    return 'text/markdown';
  }
  return 'text/plain';
}

export async function listDocuments(options?: { ids?: string[]; signal?: AbortSignal }): Promise<BaseDocument[]> {
  if (options?.ids && options.ids.length === 0) return [];
  if (options?.ids && options.ids.length > 200) {
    const documents: BaseDocument[] = [];
    for (let offset = 0; offset < options.ids.length; offset += 200) {
      documents.push(...await listDocuments({ ...options, ids: options.ids.slice(offset, offset + 200) }));
    }
    return documents;
  }
  const documents: BaseDocument[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: '200' });
    if (options?.ids?.length) params.set('ids', options.ids.join(','));
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/v1/documents?${params}`, { signal: options?.signal });
    if (!res.ok) throw await parseApiError(res, 'Failed to list documents');
    const page = await res.json() as { data: BaseDocument[]; nextCursor: string | null };
    documents.push(...page.data);
    if (page.nextCursor && page.nextCursor === cursor) throw new Error('Document pagination did not advance.');
    cursor = page.nextCursor;
  } while (cursor);
  return documents;
}

export async function getDocumentMetadata(id: string, options?: { signal?: AbortSignal }): Promise<BaseDocument | null> {
  const response = await fetch(`/api/v1/documents/${encodeURIComponent(id)}`, { signal: options?.signal });
  if (response.status === 404) return null;
  if (!response.ok) throw await parseApiError(response, 'Failed to read document');
  return await response.json() as DocumentResource;
}

export async function markDocumentOpened(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<{ documentId: string; recentlyOpenedAt: number }> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/opened`, {
    method: 'PUT',
    signal: options?.signal,
  });
  if (!res.ok) {
    throw await parseApiError(res, 'Failed to update recently opened state');
  }
  return (await res.json()) as { documentId: string; recentlyOpenedAt: number };
}

export async function forceReparsePdfDocument(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<ReaderBootstrapRestart> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/parsed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replace: true }),
    signal: options?.signal,
    cache: 'no-store',
  });

  const data = (await res.json().catch(() => null)) as {
    parseStatus?: string;
    parseProgress?: {
      phase?: string;
      pagesParsed?: number;
      totalPages?: number;
      downloadedBytes?: number;
      totalBytes?: number;
    } | null;
    opId?: string | null;
    error?: string;
    detail?: string;
  } | null;

  if (!res.ok) {
    throw new Error(data?.error || data?.detail || 'Failed to start PDF reparse');
  }
  const operationId = data?.opId?.trim();
  if (!operationId) throw new Error('PDF reparse started without an operation ID.');
  const progress = data?.parseProgress;
  return {
    operationId,
    progress: {
      kind: 'pdf-parse',
      phase: data?.parseStatus === 'running'
        ? progress?.phase === 'download_model'
          ? 'downloading-model'
          : progress?.phase === 'merge' ? 'merging' : 'parsing'
        : 'queued',
      pagesParsed: Math.max(0, Number(progress?.pagesParsed ?? 0)),
      totalPages: Math.max(0, Number(progress?.totalPages ?? 0)),
      ...(progress?.phase === 'download_model' ? {
        downloadedBytes: Math.max(0, Number(progress.downloadedBytes ?? 0)),
        totalBytes: Math.max(0, Number(progress.totalBytes ?? 0)),
      } : {}),
    },
  };
}

type DocumentSettingsResponse = {
  settings: DocumentSettings;
  clientUpdatedAtMs: number;
  hasStoredSettings?: boolean;
};

export async function getDocumentSettings(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<DocumentSettingsResponse> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/settings`, {
    signal: options?.signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    throw await parseApiError(res, 'Failed to load document settings');
  }
  return (await res.json()) as DocumentSettingsResponse;
}

export async function putDocumentSettings(
  id: string,
  settings: DocumentSettings,
  options?: { signal?: AbortSignal; clientUpdatedAtMs?: number },
): Promise<DocumentSettingsResponse & { applied: boolean }> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      settings,
      clientUpdatedAtMs: options?.clientUpdatedAtMs ?? Date.now(),
    }),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw await parseApiError(res, 'Failed to update document settings');
  }
  return (await res.json()) as DocumentSettingsResponse & { applied: boolean };
}

export async function uploadDocumentSources(sources: UploadSource[], options?: UploadOptions): Promise<BaseDocument[]> {
  if (sources.length === 0) return [];

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options?.signal?.reason);
  options?.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (options?.signal?.aborted) forwardAbort();
  const requestOptions = { ...options, signal: controller.signal };
  options?.onProgress?.({ phase: 'preparing' });

  try {
    const uploads = await Promise.all(sources.map(async source => {
      const response = await fetch('/api/v1/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: source.name, size: source.size, lastModified: source.lastModified, ...source.metadata }),
        signal: controller.signal });
      if (!response.ok) throw await parseApiError(response, 'Failed to prepare upload');
      return await response.json() as PreparedDocumentUpload;
    }));

    await transferPreparedDocumentUploads({
      sources,
      uploads,
      signal: controller.signal,
      onProgress: options?.onProgress,
    });

    return await finalizeUploadedSources(
      sources.map((source, index) => ({ id: uploads[index].id, name: source.name })),
      requestOptions,
    );
  } catch (error) {
    controller.abort(error);
    if (options?.signal?.aborted) throw error;
    if (error instanceof Error) throw error;
    throw new Error('Document upload failed', { cause: error });
  } finally {
    options?.signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function uploadDocuments(files: File[], options?: UploadOptions): Promise<BaseDocument[]> {
  if (files.length === 0) return [];

  const sources: UploadSource[] = [];
  for (const file of files) {
    const name = file.name || '';
    const type = name
      ? documentTypeForName(name)
      : (documentTypeForMime(file.type) ?? 'html');
    const resolvedName = name || `upload.${type}`;
    const contentType = file.type || mimeTypeForDoc({ name: resolvedName, type });
    sources.push({
      name: resolvedName,
      type,
      size: file.size,
      lastModified: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(),
      contentType,
      body: file,
    });
  }

  return uploadDocumentSources(sources, options);
}

export async function deleteDocuments(options?: { ids?: string[]; signal?: AbortSignal }): Promise<void> {
  const ids = options?.ids ?? (await listDocuments({ signal: options?.signal })).map(document => document.id);
  for (let offset = 0; offset < ids.length; offset += 200) {
    const params = new URLSearchParams({ ids: ids.slice(offset, offset + 200).join(',') });
    const response = await fetch(`/api/v1/documents?${params}`, { method: 'DELETE', signal: options?.signal });
    if (!response.ok) throw await parseApiError(response, 'Failed to delete documents');
  }
}

export async function downloadDocumentContent(id: string, options?: { signal?: AbortSignal }): Promise<ArrayBuffer> {
  return (await fetchDocumentContentResponse(id, options)).arrayBuffer();
}

export async function fetchDocumentContentResponse(id: string, options?: { signal?: AbortSignal }): Promise<Response> {
  const res = await fetch(`/api/v1/documents/${encodeURIComponent(id)}/file`, {
    signal: options?.signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    throw await parseApiError(res, `Failed to download document (status ${res.status})`);
  }
  return res;
}

export async function getDocumentContentSnippet(
  id: string,
  options?: { maxChars?: number; maxBytes?: number; signal?: AbortSignal },
): Promise<string> {
  const maxBytes = Math.max(1, Math.floor(options?.maxBytes ?? 128 * 1024));
  const maxChars = Math.max(1, Math.floor(options?.maxChars ?? 1600));
  const bytes = new Uint8Array(await downloadDocumentContent(id, { signal: options?.signal }));
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).slice(0, maxChars);
}

export type DocumentPreviewPending = {
  kind: 'pending';
  status: 'queued' | 'processing' | 'failed';
  opId: string | null;
  presignUrl: string;
  directUrl?: string;
};

export type DocumentPreviewReady = {
  kind: 'ready';
  presignUrl: string;
  directUrl?: string;
  previewVersion: string;
};

export type DocumentPreviewStatus = DocumentPreviewPending | DocumentPreviewReady;

function documentPreviewEnsureUrl(id: string): string {
  return `/api/documents/blob/preview/ensure?id=${encodeURIComponent(id)}`;
}

export function documentPreviewPresignUrl(id: string): string {
  return `/api/documents/blob/preview?id=${encodeURIComponent(id)}`;
}

function documentPreviewEventsUrl(id: string, opId: string): string {
  const params = new URLSearchParams();
  params.set('id', id);
  params.set('opId', opId);
  return `/api/documents/blob/preview/events?${params.toString()}`;
}

export async function getDocumentPreviewStatus(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<DocumentPreviewStatus> {
  const res = await fetch(documentPreviewEnsureUrl(id), {
    signal: options?.signal,
    cache: 'no-store',
  });

  if (res.status === 202) {
    const data = (await res.json().catch(() => null)) as {
      status?: 'queued' | 'processing' | 'failed';
      opId?: string | null;
      presignUrl?: string;
      directUrl?: string;
    } | null;
    return {
      kind: 'pending',
      status: data?.status ?? 'queued',
      opId: data?.opId || null,
      presignUrl: data?.presignUrl || documentPreviewPresignUrl(id),
      directUrl: data?.directUrl,
    };
  }

  if (res.ok) {
    const data = (await res.json().catch(() => null)) as {
      presignUrl?: string;
      directUrl?: string;
      previewVersion?: string;
    } | null;
    return {
      kind: 'ready',
      presignUrl: data?.presignUrl || documentPreviewPresignUrl(id),
      directUrl: data?.directUrl,
      previewVersion: data?.previewVersion || '',
    };
  }

  // Handle failed preview generation (500 with status: 'failed')
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = (await res.json().catch(() => null)) as {
      status?: string;
      lastError?: string;
      error?: string;
    } | null;
    if (data?.status === 'failed') {
      return {
        kind: 'pending',
        status: 'failed',
        opId: null,
        presignUrl: documentPreviewPresignUrl(id),
      };
    }
    throw new Error(data?.error || data?.lastError || `Failed to load preview status (status ${res.status})`);
  }

  throw new Error(`Failed to load preview status (status ${res.status})`);
}

export function subscribeDocumentPreviewEvents(
  id: string,
  options: {
    opId: string;
  },
  handlers: {
    onSnapshot: (snapshot: {
      status: 'queued' | 'processing' | 'ready' | 'failed';
      opId: string;
      error?: string | null;
    }) => void;
    onError?: (error: Event) => void;
  },
): () => void {
  const source = new EventSource(documentPreviewEventsUrl(id, options.opId));
  source.addEventListener('snapshot', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      const payload = JSON.parse(event.data) as {
        snapshot?: {
          opId: string;
          status: 'queued' | 'running' | 'succeeded' | 'failed';
          error?: { message?: string } | null;
        };
      };
      const snapshot = payload?.snapshot;
      if (!snapshot?.opId || !snapshot.status) return;
      handlers.onSnapshot({
        status: snapshot.status === 'running'
          ? 'processing'
          : snapshot.status === 'succeeded'
            ? 'ready'
            : snapshot.status,
        opId: snapshot.opId,
        ...(snapshot.status === 'failed' && snapshot.error?.message
          ? { error: snapshot.error.message }
          : {}),
      });
    } catch {
      // Ignore malformed payloads so EventSource can continue.
    }
  });
  source.addEventListener('error', (event) => {
    handlers.onError?.(event);
  });
  return () => {
    source.close();
  };
}

export async function createTextDocument(text: string, name: string, options?: UploadOptions): Promise<DocumentResource> {
  return createSourceDocument({ type: 'text', text }, { ...options, name });
}

export async function createDocumentFromUrl(url: string, options?: UploadOptions & { name?: string }): Promise<DocumentResource> {
  return createSourceDocument({ type: 'url', url }, options);
}

async function createSourceDocument(source: Record<string, unknown>, options?: UploadOptions & { name?: string }): Promise<DocumentResource> {
  const response = await fetch('/api/v1/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, ...(options?.name ? { name: options.name } : {}), ...(options?.folderId ? { folderId: options.folderId } : {}) }), signal: options?.signal });
  if (!response.ok) throw await parseApiError(response, 'Failed to create document');
  return await response.json() as DocumentResource;
}

export type GutenbergBook = {
  id: number;
  title: string;
  authors: string[];
  languages: string[];
  downloadCount: number;
  coverUrl: string | null;
};

export type GutenbergSearchPage = {
  count: number;
  page: number;
  hasNextPage: boolean;
  books: GutenbergBook[];
};

export async function searchGutenberg(
  search: string,
  page = 1,
  options?: { signal?: AbortSignal; language?: string },
): Promise<GutenbergSearchPage> {
  const params = new URLSearchParams({ page: String(page) });
  if (search.trim()) params.set('search', search.trim());
  if (options?.language) params.set('language', options.language);
  const res = await fetch(`/api/gutenberg/books?${params.toString()}`, { signal: options?.signal });
  if (!res.ok) {
    throw await parseApiError(res, 'Failed to search Project Gutenberg');
  }
  return (await res.json()) as GutenbergSearchPage;
}

/** The server downloads the book into a temp upload, because neither the
 * browser (no CORS on gutenberg.org) nor a function response (4.5 MB) can
 * carry it; finalizing here then files it like any other upload. */
export async function importGutenbergBook(id: number, options?: UploadOptions): Promise<BaseDocument[]> {
  options?.onProgress?.({ phase: 'preparing' });
  const res = await fetch('/api/gutenberg/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw await parseApiError(res, 'Failed to import the book');
  }
  const staged = await res.json() as { uploadId: string; name: string };
  return finalizeUploadedSources([{ id: staged.uploadId, name: staged.name }], options);
}
