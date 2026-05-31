import { sha256HexFromArrayBuffer } from '@/lib/client/sha256';
import type { BaseDocument, DocumentType } from '@/types/documents';
import type { ParsedPdfDocument, PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
import type { DocumentSettings } from '@/types/document-settings';

export type UploadSource = {
  id: string;
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

async function uploadDocumentSourceViaProxy(source: UploadSource, options?: UploadOptions): Promise<void> {
  const res = await fetch(`/api/documents/blob/upload/fallback?id=${encodeURIComponent(source.id)}`, {
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

export async function getParsedPdfDocument(
  id: string,
  options?: { signal?: AbortSignal; retryFailed?: boolean; opId?: string },
): Promise<
  | { status: 'ready'; parsed: ParsedPdfDocument }
  | { status: 'pending' | 'running' | 'failed'; parseProgress?: PdfParseProgress | null; opId?: string | null }
> {
  const params = new URLSearchParams();
  if (options?.retryFailed) params.set('retry', '1');
  if (options?.opId) params.set('opId', options.opId);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/parsed${query}`, {
    signal: options?.signal,
    cache: 'no-store',
  });

  if (res.status === 202) {
    const data = (await res.json().catch(() => null)) as {
      parseStatus?: string;
      parseProgress?: PdfParseProgress | null;
      opId?: string | null;
    } | null;
    const parseStatus = data?.parseStatus;
    if (parseStatus === 'pending' || parseStatus === 'running' || parseStatus === 'failed') {
      return { status: parseStatus, parseProgress: data?.parseProgress ?? null, opId: data?.opId ?? null };
    }
    return { status: 'pending', parseProgress: data?.parseProgress ?? null, opId: data?.opId ?? null };
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to load parsed PDF');
  }

  const parsed = (await res.json()) as ParsedPdfDocument;
  return { status: 'ready', parsed };
}

export function subscribeParsedPdfDocumentEvents(
  id: string,
  options: {
    opId?: string | null;
  },
  handlers: {
    onSnapshot: (snapshot: {
      parseStatus: PdfParseStatus;
      parseProgress: PdfParseProgress | null;
      opId?: string | null;
    }) => void;
    onError?: (error: Event) => void;
  },
): () => void {
  const params = new URLSearchParams();
  if (options.opId) params.set('opId', options.opId);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const source = new EventSource(`/api/documents/${encodeURIComponent(id)}/parsed/events${query}`);
  source.addEventListener('snapshot', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      const payload = JSON.parse(event.data) as {
        parseStatus: PdfParseStatus;
        parseProgress: PdfParseProgress | null;
        opId?: string | null;
      };
      handlers.onSnapshot(payload);
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

export async function forceReparsePdfDocument(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<{ status: 'pending' | 'running'; opId?: string | null }> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/parsed`, {
    method: 'POST',
    signal: options?.signal,
    cache: 'no-store',
  });

  if (res.status === 409) {
    const data = (await res.json().catch(() => null)) as {
      parseStatus?: string;
      opId?: string | null;
      error?: string;
    } | null;
    if (typeof data?.opId === 'string' && data.opId.trim()) {
      return {
        status: data?.parseStatus === 'running' ? 'running' : 'pending',
        opId: data.opId,
      };
    }
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to force PDF reparse');
  }

  const data = (await res.json().catch(() => null)) as { parseStatus?: string; opId?: string | null } | null;
  return {
    status: data?.parseStatus === 'running' ? 'running' : 'pending',
    opId: data?.opId ?? null,
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
        id: source.id,
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
    uploads?: Array<{ id: string; url: string; headers?: Record<string, string> }>;
  };
  const byId = new Map((presigned.uploads || []).map((upload) => [upload.id, upload]));

  for (const source of sources) {
    const upload = byId.get(source.id);
    if (!upload?.url) {
      throw new Error(`Missing presigned upload for document ${source.id}`);
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
      await uploadDocumentSourceViaProxy(source, options);
    } catch (proxyError) {
      const directMessage = putError instanceof Error ? putError.message : 'unknown direct upload error';
      const proxyMessage = proxyError instanceof Error ? proxyError.message : 'unknown proxy upload error';
      throw new Error(`Failed to upload document ${source.name}: ${directMessage}; fallback failed: ${proxyMessage}`);
    }
  }

  const registerRes = await fetch('/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documents: sources.map((source) => ({
        id: source.id,
        name: source.name,
        type: source.type,
        size: source.size,
        lastModified: source.lastModified,
      })),
    }),
    signal: options?.signal,
  });

  if (!registerRes.ok) {
    const data = (await registerRes.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to register uploaded documents');
  }

  const data = (await registerRes.json()) as { stored: BaseDocument[] };
  return data.stored || [];
}

export async function uploadDocuments(files: File[], options?: UploadOptions): Promise<BaseDocument[]> {
  if (files.length === 0) return [];

  const sources: UploadSource[] = [];
  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const id = await sha256HexFromArrayBuffer(bytes);
    const type = documentTypeForName(file.name);
    const name = file.name || `${id}.${type}`;
    const contentType = file.type || mimeTypeForDoc({ name, type });
    sources.push({
      id,
      name,
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

export async function uploadDocxAsPdf(file: File, options?: { signal?: AbortSignal }): Promise<BaseDocument> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch('/api/documents/docx-to-pdf/upload', {
    method: 'POST',
    body: form,
    signal: options?.signal,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || 'Failed to convert DOCX');
  }

  const data = (await res.json()) as { stored: BaseDocument };
  if (!data?.stored) throw new Error('DOCX conversion succeeded but returned no document');
  return data.stored;
}
