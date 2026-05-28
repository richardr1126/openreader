import {
  clearDocumentPreviewCache as clearPersistedDocumentPreviewCache,
  getDocumentPreviewCache,
  putDocumentPreviewCache,
  removeDocumentPreviewCache,
} from '@/lib/client/dexie';
import { documentPreviewFallbackUrl, documentPreviewPresignUrl } from '@/lib/client/api/documents';

const inMemoryPreviewUrlCache = new Map<string, string>();
const inFlightPreviewPrime = new Map<string, Promise<string | null>>();
const inFlightPersistedPreviewUrl = new Map<string, Promise<string | null>>();
const PREVIEW_CACHE_SCHEMA_VERSION = 4;

function revokeIfBlobUrl(url: string | null | undefined): void {
  if (!url) return;
  if (!url.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

export function getInMemoryDocumentPreviewUrl(cacheKey: string): string | null {
  return inMemoryPreviewUrlCache.get(cacheKey) || null;
}

export function setInMemoryDocumentPreviewUrl(cacheKey: string, url: string): void {
  const prev = inMemoryPreviewUrlCache.get(cacheKey);
  if (prev && prev !== url) {
    revokeIfBlobUrl(prev);
  }
  inMemoryPreviewUrlCache.set(cacheKey, url);
}

export function clearInMemoryDocumentPreviewCache(): void {
  for (const value of inMemoryPreviewUrlCache.values()) {
    revokeIfBlobUrl(value);
  }
  inMemoryPreviewUrlCache.clear();
  inFlightPersistedPreviewUrl.clear();
}

export async function getPersistedDocumentPreviewUrl(
  docId: string,
  lastModified: number,
  cacheKey: string,
): Promise<string | null> {
  const cachedUrl = getInMemoryDocumentPreviewUrl(cacheKey);
  if (cachedUrl) return cachedUrl;

  const persistedKey = `${cacheKey}:${Number(lastModified)}`;
  const existing = inFlightPersistedPreviewUrl.get(persistedKey);
  if (existing) {
    return existing;
  }

  const promise = (async (): Promise<string | null> => {
    const row = await getDocumentPreviewCache(docId);
    if (!row) return null;

    if (Number((row as { previewVersion?: number }).previewVersion ?? 1) !== PREVIEW_CACHE_SCHEMA_VERSION) {
      await removeDocumentPreviewCache(docId).catch(() => {});
      return null;
    }

    if (Number(row.lastModified) !== Number(lastModified)) {
      await removeDocumentPreviewCache(docId).catch(() => {});
      return null;
    }

    const latestCachedUrl = getInMemoryDocumentPreviewUrl(cacheKey);
    if (latestCachedUrl) return latestCachedUrl;

    const contentType = row.contentType || 'image/jpeg';
    const bytes = row.data;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
      await removeDocumentPreviewCache(docId).catch(() => {});
      return null;
    }

    const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
    setInMemoryDocumentPreviewUrl(cacheKey, url);
    return url;
  })();

  inFlightPersistedPreviewUrl.set(persistedKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightPersistedPreviewUrl.get(persistedKey) === promise) {
      inFlightPersistedPreviewUrl.delete(persistedKey);
    }
  }
}

export async function primeDocumentPreviewCache(
  docId: string,
  lastModified: number,
  cacheKey: string,
  options?: { signal?: AbortSignal },
): Promise<string | null> {
  const primeKey = `${cacheKey}:${Number(lastModified)}`;
  const existingPrime = inFlightPreviewPrime.get(primeKey);
  if (existingPrime) {
    return existingPrime;
  }

  const promise = (async (): Promise<string | null> => {
  const existing = await getPersistedDocumentPreviewUrl(docId, lastModified, cacheKey);
  if (existing) return existing;

  const fetchOptions = {
    signal: options?.signal,
    cache: 'no-store' as const,
  };

  // Prefer presign path for priming so healthy direct object access avoids proxy load.
  let res = await fetch(documentPreviewPresignUrl(docId), fetchOptions).catch(() => null);
  if (!res || !res.ok) {
    res = await fetch(documentPreviewFallbackUrl(docId), fetchOptions).catch(() => null);
  }
  if (!res || !res.ok) return null;

  const blob = await res.blob();
  const bytes = await blob.arrayBuffer();
  if (bytes.byteLength === 0) return null;

  const contentType = blob.type || 'image/jpeg';
  await putDocumentPreviewCache({
    docId,
    lastModified: Number(lastModified),
    contentType,
    data: bytes,
    cachedAt: Date.now(),
    previewVersion: PREVIEW_CACHE_SCHEMA_VERSION,
  });

  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  setInMemoryDocumentPreviewUrl(cacheKey, url);
  return url;
  })();

  inFlightPreviewPrime.set(primeKey, promise);
  try {
    return await promise;
  } finally {
    if (inFlightPreviewPrime.get(primeKey) === promise) {
      inFlightPreviewPrime.delete(primeKey);
    }
  }
}

export async function clearAllDocumentPreviewCaches(): Promise<void> {
  clearInMemoryDocumentPreviewCache();
  await clearPersistedDocumentPreviewCache();
}
