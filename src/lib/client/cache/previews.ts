import { documentPreviewFallbackUrl, documentPreviewPresignUrl } from '@/lib/client/api/documents';
import { clearBlobCache, getCachedBlob, previewBlobCacheKey } from '@/lib/client/cache/blob-cache';

const inMemoryPreviewUrlCache = new Map<string, string>();
const inFlightPreviewPrime = new Map<string, Promise<string | null>>();

function revokeIfBlobUrl(url: string | null | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

export function getInMemoryDocumentPreviewUrl(cacheKey: string): string | null {
  return inMemoryPreviewUrlCache.get(cacheKey) || null;
}

export function setInMemoryDocumentPreviewUrl(cacheKey: string, url: string): void {
  const prev = inMemoryPreviewUrlCache.get(cacheKey);
  if (prev && prev !== url) revokeIfBlobUrl(prev);
  inMemoryPreviewUrlCache.set(cacheKey, url);
}

export function clearInMemoryDocumentPreviewCache(): void {
  for (const value of inMemoryPreviewUrlCache.values()) revokeIfBlobUrl(value);
  inMemoryPreviewUrlCache.clear();
}

async function fetchPreviewSource(docId: string, signal?: AbortSignal): Promise<Response> {
  const options = { signal, cache: 'no-store' as const };
  const direct = await fetch(documentPreviewPresignUrl(docId), options).catch(() => null);
  if (direct?.ok) return direct;
  return fetch(documentPreviewFallbackUrl(docId), options);
}

export async function getPersistedDocumentPreviewUrl(
  docId: string,
  previewVersion: string | number,
  cacheKey: string,
): Promise<string | null> {
  return primeDocumentPreviewCache(docId, previewVersion, cacheKey);
}

export async function primeDocumentPreviewCache(
  docId: string,
  previewVersion: string | number,
  cacheKey: string,
  options?: { signal?: AbortSignal },
): Promise<string | null> {
  const memory = getInMemoryDocumentPreviewUrl(cacheKey);
  if (memory) return memory;
  const primeKey = `${docId}:${previewVersion}`;
  const existing = inFlightPreviewPrime.get(primeKey);
  if (existing) return existing;
  const promise = (async () => {
    const response = await getCachedBlob(
      previewBlobCacheKey(docId, previewVersion),
      () => fetchPreviewSource(docId, options?.signal),
    ).catch(() => null);
    if (!response?.ok) return null;
    const blob = await response.blob();
    if (blob.size === 0) return null;
    const url = URL.createObjectURL(blob);
    setInMemoryDocumentPreviewUrl(cacheKey, url);
    return url;
  })();
  inFlightPreviewPrime.set(primeKey, promise);
  try {
    return await promise;
  } finally {
    inFlightPreviewPrime.delete(primeKey);
  }
}

export async function clearAllDocumentPreviewCaches(): Promise<void> {
  clearInMemoryDocumentPreviewCache();
  await clearBlobCache();
}
