import { documentPreviewPresignUrl } from '@/lib/client/api/documents';
import { evictCachedBlobPrefix, getCachedBlob, previewBlobCacheKey } from '@/lib/client/cache/blob-cache';

const inMemoryPreviewUrlCache = new Map<string, string>();
const inFlightPreviewPrime = new Map<string, Promise<string | null>>();
const MAX_IN_MEMORY_PREVIEWS = 100;

function revokeIfBlobUrl(url: string | null | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

export function getInMemoryDocumentPreviewUrl(cacheKey: string): string | null {
  const value = inMemoryPreviewUrlCache.get(cacheKey);
  if (!value) return null;
  inMemoryPreviewUrlCache.delete(cacheKey);
  inMemoryPreviewUrlCache.set(cacheKey, value);
  return value;
}

export function setInMemoryDocumentPreviewUrl(cacheKey: string, url: string): void {
  const prev = inMemoryPreviewUrlCache.get(cacheKey);
  if (prev && prev !== url) revokeIfBlobUrl(prev);
  if (prev) inMemoryPreviewUrlCache.delete(cacheKey);
  inMemoryPreviewUrlCache.set(cacheKey, url);
  if (inMemoryPreviewUrlCache.size > MAX_IN_MEMORY_PREVIEWS) {
    const oldestKey = inMemoryPreviewUrlCache.keys().next().value;
    if (oldestKey !== undefined) {
      revokeIfBlobUrl(inMemoryPreviewUrlCache.get(oldestKey));
      inMemoryPreviewUrlCache.delete(oldestKey);
    }
  }
}

export function clearInMemoryDocumentPreviewCache(): void {
  for (const value of inMemoryPreviewUrlCache.values()) revokeIfBlobUrl(value);
  inMemoryPreviewUrlCache.clear();
}

async function fetchPreviewSource(docId: string, signal?: AbortSignal): Promise<Response> {
  return fetch(documentPreviewPresignUrl(docId), { signal, cache: 'no-store' });
}

function isReadyPreviewImage(response: Response): boolean {
  return response.status === 200
    && response.headers.get('content-type')?.toLowerCase().startsWith('image/') === true;
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
    // A preview that is still generating responds with 202 JSON. Treating any
    // 2xx response as an image creates a broken blob URL and prevents the
    // caller from subscribing to the completion event stream.
    if (!response || !isReadyPreviewImage(response)) return null;
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
  await evictCachedBlobPrefix('/openreader-cache/previews/');
}
