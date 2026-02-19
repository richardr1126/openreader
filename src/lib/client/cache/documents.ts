import type { BaseDocument, EPUBDocument, HTMLDocument, PDFDocument } from '@/types/documents';
import { downloadDocumentContent } from '@/lib/client/api/documents';

export type DocumentCacheBackend = {
  get: (meta: BaseDocument) => Promise<PDFDocument | EPUBDocument | HTMLDocument | null>;
  putPdf: (meta: BaseDocument, data: ArrayBuffer) => Promise<void>;
  putEpub: (meta: BaseDocument, data: ArrayBuffer) => Promise<void>;
  putHtml: (meta: BaseDocument, data: string) => Promise<void>;
  download: (id: string, options?: { signal?: AbortSignal }) => Promise<ArrayBuffer>;
  decodeText: (buffer: ArrayBuffer) => string;
};

export async function ensureCachedDocumentCore(
  meta: BaseDocument,
  backend: DocumentCacheBackend,
  options?: { signal?: AbortSignal },
): Promise<PDFDocument | EPUBDocument | HTMLDocument> {
  const cached = await backend.get(meta);
  if (cached) return cached;

  const buffer = await backend.download(meta.id, { signal: options?.signal });

  if (meta.type === 'pdf') {
    await backend.putPdf(meta, buffer);
    const after = await backend.get(meta);
    if (!after || after.type !== 'pdf') throw new Error('Failed to cache PDF');
    return after;
  }

  if (meta.type === 'epub') {
    await backend.putEpub(meta, buffer);
    const after = await backend.get(meta);
    if (!after || after.type !== 'epub') throw new Error('Failed to cache EPUB');
    return after;
  }

  const decoded = backend.decodeText(buffer);
  await backend.putHtml(meta, decoded);
  const after = await backend.get(meta);
  if (!after || after.type !== 'html') throw new Error('Failed to cache HTML');
  return after;
}

export async function getCachedPdf(id: string): Promise<PDFDocument | null> {
  const { getPdfDocument } = await import('@/lib/client/dexie');
  return (await getPdfDocument(id)) ?? null;
}

export async function putCachedPdf(meta: BaseDocument, data: ArrayBuffer): Promise<void> {
  const { addPdfDocument } = await import('@/lib/client/dexie');
  await addPdfDocument({
    id: meta.id,
    type: 'pdf',
    name: meta.name,
    size: meta.size,
    lastModified: meta.lastModified,
    data,
  });
}

export async function evictCachedPdf(id: string): Promise<void> {
  const { removePdfDocument } = await import('@/lib/client/dexie');
  await removePdfDocument(id);
}

export async function getCachedEpub(id: string): Promise<EPUBDocument | null> {
  const { getEpubDocument } = await import('@/lib/client/dexie');
  return (await getEpubDocument(id)) ?? null;
}

export async function putCachedEpub(meta: BaseDocument, data: ArrayBuffer): Promise<void> {
  const { addEpubDocument } = await import('@/lib/client/dexie');
  await addEpubDocument({
    id: meta.id,
    type: 'epub',
    name: meta.name,
    size: meta.size,
    lastModified: meta.lastModified,
    data,
  });
}

export async function evictCachedEpub(id: string): Promise<void> {
  const { removeEpubDocument } = await import('@/lib/client/dexie');
  await removeEpubDocument(id);
}

export async function getCachedHtml(id: string): Promise<HTMLDocument | null> {
  const { getHtmlDocument } = await import('@/lib/client/dexie');
  return (await getHtmlDocument(id)) ?? null;
}

export async function putCachedHtml(meta: BaseDocument, data: string): Promise<void> {
  const { addHtmlDocument } = await import('@/lib/client/dexie');
  await addHtmlDocument({
    id: meta.id,
    type: 'html',
    name: meta.name,
    size: meta.size,
    lastModified: meta.lastModified,
    data,
  });
}

export async function evictCachedHtml(id: string): Promise<void> {
  const { removeHtmlDocument } = await import('@/lib/client/dexie');
  await removeHtmlDocument(id);
}

export async function clearDocumentCache(): Promise<void> {
  const { clearPdfDocuments, clearEpubDocuments, clearHtmlDocuments } = await import('@/lib/client/dexie');
  await Promise.all([clearPdfDocuments(), clearEpubDocuments(), clearHtmlDocuments()]);
}

export async function cacheStoredDocumentFromBytes(stored: BaseDocument, bytes: ArrayBuffer): Promise<void> {
  if (stored.type === 'pdf') {
    await putCachedPdf(stored, bytes);
    return;
  }
  if (stored.type === 'epub') {
    await putCachedEpub(stored, bytes);
    return;
  }
  if (stored.type === 'html') {
    const decoded = new TextDecoder().decode(new Uint8Array(bytes));
    await putCachedHtml(stored, decoded);
  }
}

export async function ensureCachedDocument(meta: BaseDocument, options?: { signal?: AbortSignal }): Promise<PDFDocument | EPUBDocument | HTMLDocument> {
  return ensureCachedDocumentCore(
    meta,
    {
      get: async (m) => {
        const { getPdfDocument, getEpubDocument, getHtmlDocument } = await import('@/lib/client/dexie');
        if (m.type === 'pdf') return (await getPdfDocument(m.id)) ?? null;
        if (m.type === 'epub') return (await getEpubDocument(m.id)) ?? null;
        return (await getHtmlDocument(m.id)) ?? null;
      },
      putPdf: putCachedPdf,
      putEpub: putCachedEpub,
      putHtml: putCachedHtml,
      download: downloadDocumentContent,
      decodeText: (buffer) => new TextDecoder().decode(new Uint8Array(buffer)),
    },
    options,
  );
}
