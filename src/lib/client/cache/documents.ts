import type { BaseDocument, EPUBDocument, HTMLDocument, PDFDocument } from '@/types/documents';
import { fetchDocumentContentResponse } from '@/lib/client/api/documents';
import {
  clearBlobCache,
  documentBlobCacheKey,
  evictCachedBlobPrefix,
  getCachedBlob,
  putCachedBlob,
} from '@/lib/client/cache/blob-cache';

function stableKey(meta: BaseDocument): string {
  return documentBlobCacheKey(meta.id, meta.contentVersion || meta.id);
}

async function readDocument(meta: BaseDocument, response: Response): Promise<PDFDocument | EPUBDocument | HTMLDocument> {
  if (meta.type === 'html') {
    return { ...meta, type: 'html', data: await response.text() };
  }
  const data = await response.arrayBuffer();
  if (meta.type === 'epub') return { ...meta, type: 'epub', data };
  return { ...meta, type: 'pdf', data };
}

export async function ensureCachedDocument(
  meta: BaseDocument,
  options?: { signal?: AbortSignal },
): Promise<PDFDocument | EPUBDocument | HTMLDocument> {
  if (meta.type !== 'pdf' && meta.type !== 'epub' && meta.type !== 'html') {
    throw new Error(`Unsupported cached document type: ${meta.type}`);
  }
  const response = await getCachedBlob(stableKey(meta), () => fetchDocumentContentResponse(meta.id, options));
  return readDocument(meta, response);
}

export async function cacheStoredDocumentFromBytes(stored: BaseDocument, bytes: ArrayBuffer): Promise<void> {
  const type = stored.type === 'pdf'
    ? 'application/pdf'
    : stored.type === 'epub'
      ? 'application/epub+zip'
      : 'text/plain; charset=utf-8';
  await putCachedBlob(stableKey(stored), new Response(bytes, { status: 200, headers: { 'Content-Type': type } }));
}

export async function evictCachedDocument(id: string): Promise<void> {
  await evictCachedBlobPrefix(`/openreader-cache/documents/${encodeURIComponent(id)}/`);
}

export async function clearDocumentCache(): Promise<void> {
  await clearBlobCache();
}
