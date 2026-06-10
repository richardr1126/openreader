import type { BaseDocument, DocumentType } from '@/types/documents';
import type { ParsedPdfDocument, PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
import type { DocumentSettings } from '@/types/document-settings';

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

function toUploadBody(body: UploadSource['body']): BodyInit {
  if (body instanceof Blob) return body;
  if (body instanceof ArrayBuffer) return body;
  return body as unknown as BodyInit;
}

async function uploadDocumentSourceViaProxy(
  source: UploadSource,
  token: string,
  options?: UploadOptions,
): Promise<void> {
  const res = await fetch(`/api/documents/blob/upload/fallback?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'Content-Type': source.contentType || 'application/octet-stream' },
    body: toUploadBody(source.body),
    signal: options?.signal,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `Proxy upload failed (status ${res.status})`);
  }
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
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to list documents');
  }

  const data = (await res.json()) as { documents: BaseDocument[] };
  return data.documents || [];
}

export async function getDocumentMetadata(id: string, options?: { signal?: AbortSignal }): Promise<BaseDocument | null> {
  const docs = await listDocuments({ ids: [id], signal: options?.signal });
  return docs[0] ?? null;
}

export class ParsedPdfNotReadyError extends Error {
  readonly parseStatus: PdfParseStatus;
  readonly parseProgress: PdfParseProgress | null;
  readonly opId: string | null;
  readonly details: string | null;

  constructor(input: {
    parseStatus: PdfParseStatus;
    parseProgress: PdfParseProgress | null;
    opId?: string | null;
    details?: string | null;
  }) {
    super(`Parsed PDF is not ready (${input.parseStatus})`);
    this.name = 'ParsedPdfNotReadyError';
    this.parseStatus = input.parseStatus;
    this.parseProgress = input.parseProgress;
    this.opId = input.opId?.trim() || null;
    this.details = input.details?.trim() || null;
  }
}

export async function getParsedPdfDocument(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<ParsedPdfDocument> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/parsed`, {
    signal: options?.signal,
    cache: 'no-store',
  });

  if (res.status === 409) {
    const data = (await res.json().catch(() => null)) as {
      parseStatus?: string;
      parseProgress?: PdfParseProgress | null;
      opId?: string | null;
      error?: string;
    } | null;
    throw new ParsedPdfNotReadyError({
      parseStatus: data?.parseStatus === 'running'
        ? 'running'
        : data?.parseStatus === 'ready'
          ? 'ready'
          : data?.parseStatus === 'failed'
            ? 'failed'
            : 'pending',
      parseProgress: data?.parseProgress ?? null,
      opId: data?.opId ?? null,
      details: data?.error ?? null,
    });
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to load parsed PDF');
  }

  return (await res.json()) as ParsedPdfDocument;
}

export function subscribeParsedPdfDocumentEvents(
  id: string,
  options: {
    opId: string;
  },
  handlers: {
    onSnapshot: (snapshot: {
      parseStatus: PdfParseStatus;
      parseProgress: PdfParseProgress | null;
      opId?: string | null;
      error?: string | null;
    }) => void;
    onError?: (error: Event) => void;
  },
): () => void {
  const params = new URLSearchParams();
  params.set('opId', options.opId);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const source = new EventSource(`/api/documents/${encodeURIComponent(id)}/parsed/events${query}`);
  source.addEventListener('snapshot', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      const payload = JSON.parse(event.data) as {
        snapshot?: {
          opId: string;
          status: 'queued' | 'running' | 'succeeded' | 'failed';
          progress?: PdfParseProgress | null;
          error?: { message?: string } | null;
        };
      };
      const snapshot = payload?.snapshot;
      if (!snapshot?.opId || !snapshot.status) return;
      handlers.onSnapshot({
        parseStatus: snapshot.status === 'running'
          ? 'running'
          : snapshot.status === 'succeeded'
            ? 'ready'
            : snapshot.status === 'failed'
              ? 'failed'
              : 'pending',
        parseProgress: snapshot.status === 'running' ? (snapshot.progress ?? null) : null,
        opId: snapshot.opId,
        ...(snapshot.status === 'failed' && snapshot.error?.message
          ? { error: snapshot.error.message }
          : {}),
      });
    } catch {
      // Ignore malformed payloads to avoid breaking active streams.
    }
  });
  source.addEventListener('error', (event) => {
    handlers.onError?.(event);
  });
  return () => {
    source.close();
  };
}

function normalizeParsedPdfOperationResponse(
  data: { parseStatus?: string; parseProgress?: PdfParseProgress | null; opId?: string | null; error?: string } | null,
): {
  parseStatus: PdfParseStatus;
  parseProgress: PdfParseProgress | null;
  opId: string | null;
  error?: string | null;
} {
  return {
    parseStatus: data?.parseStatus === 'running'
      ? 'running'
      : data?.parseStatus === 'ready'
        ? 'ready'
        : data?.parseStatus === 'failed'
          ? 'failed'
          : 'pending',
    parseProgress: data?.parseProgress ?? null,
    opId: data?.opId?.trim() || null,
    ...(data?.error ? { error: data.error } : {}),
  };
}

export async function ensureParsedPdfDocumentOperation(
  id: string,
  options?: { signal?: AbortSignal; replace?: boolean },
): Promise<{
  parseStatus: PdfParseStatus;
  parseProgress: PdfParseProgress | null;
  opId: string | null;
  error?: string | null;
}> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/parsed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replace: options?.replace === true }),
    signal: options?.signal,
    cache: 'no-store',
  });

  const data = (await res.json().catch(() => null)) as {
    parseStatus?: string;
    parseProgress?: PdfParseProgress | null;
    opId?: string | null;
    error?: string;
  } | null;

  if (!res.ok && res.status !== 409) {
    throw new Error(data?.error || 'Failed to ensure parsed PDF operation');
  }

  return normalizeParsedPdfOperationResponse(data);
}

export async function forceReparsePdfDocument(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<{ status: 'pending' | 'running'; opId?: string | null }> {
  const data = await ensureParsedPdfDocumentOperation(id, {
    signal: options?.signal,
    replace: true,
  });
  return {
    status: data.parseStatus === 'running' ? 'running' : 'pending',
    opId: data.opId,
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
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to load document settings');
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
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to update document settings');
  }
  return (await res.json()) as DocumentSettingsResponse & { applied: boolean };
}

export async function uploadDocumentSources(sources: UploadSource[], options?: UploadOptions): Promise<BaseDocument[]> {
  if (sources.length === 0) return [];

  const presignRes = await fetch('/api/documents/blob/upload/presign', {
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
      throw new Error(`Missing presigned upload for document ${source.name}`);
    }

    let putError: unknown = null;
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
      putError = new Error(`Direct upload failed with status ${putRes.status}`);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      putError = error;
    }

    try {
      await uploadDocumentSourceViaProxy(source, upload.token, options);
    } catch (proxyError) {
      const directMessage = putError instanceof Error ? putError.message : 'unknown direct upload error';
      const proxyMessage = proxyError instanceof Error ? proxyError.message : 'unknown proxy upload error';
      throw new Error(`Failed to upload document ${source.name}: ${directMessage}; fallback failed: ${proxyMessage}`);
    }
  }

  const finalizeRes = await fetch('/api/documents/blob/upload/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploads: sources.map((source, index) => ({
        token: uploads[index]?.token,
        name: source.name,
        type: source.type,
        lastModified: source.lastModified,
      })),
    }),
    signal: options?.signal,
  });

  if (!finalizeRes.ok) {
    const data = (await finalizeRes.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to finalize uploaded documents');
  }

  const data = (await finalizeRes.json()) as { stored: BaseDocument[] };
  return data.stored || [];
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
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to delete documents');
  }
}

export async function downloadDocumentContent(id: string, options?: { signal?: AbortSignal }): Promise<ArrayBuffer> {
  const fallbackUrl = `/api/documents/blob/get/fallback?id=${encodeURIComponent(id)}`;

  const fetchFallback = async (): Promise<ArrayBuffer> => {
    const res = await fetch(fallbackUrl, { signal: options?.signal });
    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `Failed to download document (status ${res.status})`);
      }
      throw new Error(`Failed to download document (status ${res.status})`);
    }
    return res.arrayBuffer();
  };

  try {
    const directRes = await fetch(`/api/documents/blob/get/presign?id=${encodeURIComponent(id)}`, {
      signal: options?.signal,
      cache: 'no-store',
    });
    if (!directRes.ok) {
      const contentType = directRes.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = (await directRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `Failed to download document (status ${directRes.status})`);
      }
      throw new Error(`Failed to download document (status ${directRes.status})`);
    }
    return directRes.arrayBuffer();
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    return fetchFallback();
  }
}

export async function getDocumentContentSnippet(
  id: string,
  options?: { maxChars?: number; maxBytes?: number; signal?: AbortSignal },
): Promise<string> {
  const params = new URLSearchParams();
  params.set('id', id);
  params.set('snippet', '1');
  if (typeof options?.maxChars === 'number') params.set('maxChars', String(options.maxChars));
  if (typeof options?.maxBytes === 'number') params.set('maxBytes', String(options.maxBytes));

  const res = await fetch(`/api/documents/blob/preview/fallback?${params.toString()}`, { signal: options?.signal });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `Failed to load content snippet (status ${res.status})`);
  }

  const data = (await res.json()) as { snippet?: string };
  return data?.snippet || '';
}

export type DocumentPreviewPending = {
  kind: 'pending';
  status: 'queued' | 'processing' | 'failed';
  retryAfterMs: number;
  fallbackUrl: string;
  presignUrl: string;
  directUrl?: string;
};

export type DocumentPreviewReady = {
  kind: 'ready';
  fallbackUrl: string;
  presignUrl: string;
  directUrl?: string;
};

export type DocumentPreviewStatus = DocumentPreviewPending | DocumentPreviewReady;

function documentPreviewEnsureUrl(id: string): string {
  return `/api/documents/blob/preview/ensure?id=${encodeURIComponent(id)}`;
}

export function documentPreviewPresignUrl(id: string): string {
  return `/api/documents/blob/preview/presign?id=${encodeURIComponent(id)}`;
}

export function documentPreviewFallbackUrl(id: string): string {
  return `/api/documents/blob/preview/fallback?id=${encodeURIComponent(id)}`;
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
      retryAfterMs?: number;
      fallbackUrl?: string;
      presignUrl?: string;
      directUrl?: string;
    } | null;
    return {
      kind: 'pending',
      status: data?.status ?? 'queued',
      retryAfterMs: Number.isFinite(data?.retryAfterMs) ? Number(data?.retryAfterMs) : 1500,
      fallbackUrl: data?.fallbackUrl || documentPreviewFallbackUrl(id),
      presignUrl: data?.presignUrl || documentPreviewPresignUrl(id),
      directUrl: data?.directUrl,
    };
  }

  if (res.ok) {
    const data = (await res.json().catch(() => null)) as {
      fallbackUrl?: string;
      presignUrl?: string;
      directUrl?: string;
    } | null;
    return {
      kind: 'ready',
      fallbackUrl: data?.fallbackUrl || documentPreviewFallbackUrl(id),
      presignUrl: data?.presignUrl || documentPreviewPresignUrl(id),
      directUrl: data?.directUrl,
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
        retryAfterMs: 0,
        fallbackUrl: documentPreviewFallbackUrl(id),
        presignUrl: documentPreviewPresignUrl(id),
      };
    }
    throw new Error(data?.error || data?.lastError || `Failed to load preview status (status ${res.status})`);
  }

  throw new Error(`Failed to load preview status (status ${res.status})`);
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
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to import URL');
  }

  return (await res.json()) as { title: string; content: string };
}

