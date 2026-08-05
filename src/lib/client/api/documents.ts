import type { BaseDocument, DocumentType } from '@/types/documents';
import type { DocumentSettings } from '@/types/document-settings';
import type { ReaderBootstrapRestart } from '@/types/reader-bootstrap';
import { parseApiError } from '@/lib/client/api/http';

export type UploadSource = {
  name: string;
  type: DocumentType;
  size: number;
  lastModified: number;
  contentType: string;
  body: Blob | ArrayBuffer | Uint8Array;
};

type UploadOptions = {
  signal?: AbortSignal;
};

type FinalizeUploadPayload = {
  token: string | undefined;
  name: string;
  type: DocumentType;
  lastModified: number;
};

type FinalizeResponse = {
  stored?: BaseDocument[];
  conversions?: Array<{
    token: string;
    name: string;
    conversionId: string;
    opId: string | null;
    status: 'queued' | 'running' | 'failed';
    error?: string;
  }>;
  error?: string;
};

const DOCUMENT_CONVERSION_TIMEOUT_MS = 5 * 60 * 1000;

export class DocumentConversionPendingError extends Error {
  readonly conversions: NonNullable<FinalizeResponse['conversions']>;
  readonly stored: BaseDocument[];

  constructor(input: {
    conversions: NonNullable<FinalizeResponse['conversions']>;
    stored: BaseDocument[];
  }) {
    super('DOCX conversion is still running');
    this.name = 'DocumentConversionPendingError';
    this.conversions = input.conversions;
    this.stored = input.stored;
  }
}

function toUploadBody(body: UploadSource['body']): BodyInit {
  if (body instanceof Blob) return body;
  if (body instanceof ArrayBuffer) return body;
  return body as unknown as BodyInit;
}

type PendingDocumentConversion = NonNullable<FinalizeResponse['conversions']>[number];

function documentConversionEventsUrl(conversion: PendingDocumentConversion): string {
  const params = new URLSearchParams();
  params.set('opId', conversion.opId ?? '');
  params.set('token', conversion.token);
  return `/api/documents/blob/upload/events?${params.toString()}`;
}

function waitForDocumentConversion(
  conversion: PendingDocumentConversion,
  signal?: AbortSignal,
): Promise<void> {
  if (!conversion.opId) {
    return Promise.reject(new Error(`DOCX conversion did not provide an operation for ${conversion.name}`));
  }
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error('Document upload aborted'),
    );
  }

  return new Promise<void>((resolve, reject) => {
    const source = new EventSource(documentConversionEventsUrl(conversion));
    const timeout = setTimeout(() => {
      cleanup();
      reject(new DocumentConversionPendingError({ conversions: [conversion], stored: [] }));
    }, DOCUMENT_CONVERSION_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', handleAbort);
      source.close();
    };
    const handleAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Document upload aborted'));
    };
    const handleSnapshot = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          snapshot?: {
            status?: 'queued' | 'running' | 'succeeded' | 'failed';
            error?: { message?: string } | null;
          };
        };
        const snapshot = payload.snapshot;
        if (snapshot?.status === 'succeeded') {
          cleanup();
          resolve();
        } else if (snapshot?.status === 'failed') {
          cleanup();
          reject(new Error(snapshot.error?.message || `DOCX conversion failed for ${conversion.name}`));
        }
      } catch {
        // Ignore malformed frames so EventSource can reconnect and continue.
      }
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    source.addEventListener('snapshot', handleSnapshot);
  });
}

async function waitForDocumentConversions(
  conversions: PendingDocumentConversion[],
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();

  try {
    await Promise.all(conversions.map((conversion) => (
      waitForDocumentConversion(conversion, controller.signal)
    )));
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }
}

async function requestUploadFinalization(
  uploads: FinalizeUploadPayload[],
  options?: UploadOptions,
): Promise<{ response: Response; data: FinalizeResponse | null }> {
  const response = await fetch('/api/documents/blob/upload/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploads }),
    signal: options?.signal,
  });
  const data = (await response.json().catch(() => null)) as FinalizeResponse | null;
  return { response, data };
}

async function finalizeUploadedSources(
  uploads: FinalizeUploadPayload[],
  options?: UploadOptions,
): Promise<BaseDocument[]> {
  let { response, data } = await requestUploadFinalization(uploads, options);

  if (response.status === 202) {
    const conversions = data?.conversions ?? [];
    if (conversions.length === 0) {
      throw new Error('Pending DOCX conversion response did not include any operations');
    }
    await waitForDocumentConversions(conversions, options?.signal);
    ({ response, data } = await requestUploadFinalization(uploads, options));
  }

  if (response.status === 202) {
    throw new DocumentConversionPendingError({
      conversions: data?.conversions ?? [],
      stored: data?.stored ?? [],
    });
  }
  if (response.ok) {
    return data?.stored || [];
  }

  const failed = data?.conversions?.find((conversion) => conversion.status === 'failed');
  throw new Error(failed?.error || data?.error || 'Failed to finalize uploaded documents');
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
  const params = new URLSearchParams();
  if (options?.ids?.length) {
    params.set('ids', options.ids.join(','));
  }

  const res = await fetch(`/api/documents?${params.toString()}`, { signal: options?.signal });
  if (!res.ok) {
    throw await parseApiError(res, 'Failed to list documents');
  }

  const data = (await res.json()) as { documents: BaseDocument[] };
  return data.documents || [];
}

export async function getDocumentMetadata(id: string, options?: { signal?: AbortSignal }): Promise<BaseDocument | null> {
  const docs = await listDocuments({ ids: [id], signal: options?.signal });
  return docs[0] ?? null;
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
        ? progress?.phase === 'merge' ? 'merging' : 'parsing'
        : 'queued',
      pagesParsed: Math.max(0, Number(progress?.pagesParsed ?? 0)),
      totalPages: Math.max(0, Number(progress?.totalPages ?? 0)),
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

  const presignRes = await fetch('/api/documents/blob/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploads: sources.map((source) => ({
        contentType: source.contentType,
        size: source.size,
      })),
    }),
    signal: options?.signal,
  });

  if (!presignRes.ok) {
    const data = (await presignRes.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to prepare uploads');
  }

  const presigned = (await presignRes.json()) as {
    uploads?: Array<{ token: string; url: string; headers?: Record<string, string> }>;
  };
  const uploads = presigned.uploads || [];
  if (uploads.length !== sources.length) {
    throw new Error('Upload preparation returned an unexpected number of temp uploads');
  }

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const upload = uploads[index];
    if (!upload?.url || !upload.token) {
      throw new Error(`Missing prepared upload for document ${source.name}`);
    }

    try {
      const putRes = await fetch(upload.url, {
        method: 'PUT',
        headers: new Headers(upload.headers || {}),
        body: toUploadBody(source.body),
        signal: options?.signal,
      });

      // 412 means the content-hash object already exists (idempotent upload).
      if (putRes.ok || putRes.status === 412) {
        continue;
      }
      throw new Error(`Document upload failed with status ${putRes.status}`);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : 'unknown upload error';
      throw new Error(`Failed to upload document ${source.name}: ${message}`);
    }
  }

  return finalizeUploadedSources(
    sources.map((source, index) => ({
      token: uploads[index]?.token,
      name: source.name,
      type: source.type,
      lastModified: source.lastModified,
    })),
    options,
  );
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
  const params = new URLSearchParams();
  if (options?.ids?.length) {
    params.set('ids', options.ids.join(','));
  }

  const url = params.toString() ? `/api/documents?${params.toString()}` : '/api/documents';
  const res = await fetch(url, { method: 'DELETE', signal: options?.signal });
  if (!res.ok) {
    throw await parseApiError(res, 'Failed to delete documents');
  }
}

export async function downloadDocumentContent(id: string, options?: { signal?: AbortSignal }): Promise<ArrayBuffer> {
  return (await fetchDocumentContentResponse(id, options)).arrayBuffer();
}

export async function fetchDocumentContentResponse(id: string, options?: { signal?: AbortSignal }): Promise<Response> {
  const res = await fetch(`/api/documents/blob/get?id=${encodeURIComponent(id)}`, {
    signal: options?.signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error || `Failed to download document (status ${res.status})`);
    }
    throw new Error(`Failed to download document (status ${res.status})`);
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

export async function importUrl(
  url: string,
  options?: { signal?: AbortSignal }
): Promise<{ title: string; content: string }> {
  const res = await fetch('/api/documents/import-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw await parseApiError(res, 'Failed to import URL');
  }

  return (await res.json()) as { title: string; content: string };
}
