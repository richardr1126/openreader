const BLOB_CACHE_NAME = 'openreader-blobs-v1';

function canUseCacheStorage(): boolean {
  return typeof window !== 'undefined' && typeof caches !== 'undefined';
}

function isCacheableFullResponse(response: Response): boolean {
  return response.ok
    && response.status === 200
    && response.type !== 'opaque'
    && response.type !== 'opaqueredirect'
    && !response.headers.has('Content-Range');
}

export async function getCachedBlob(
  stableKey: string,
  fetchSource: () => Promise<Response>,
): Promise<Response> {
  let cache: Cache | null = null;
  if (canUseCacheStorage()) {
    try {
      cache = await caches.open(BLOB_CACHE_NAME);
      const cached = await cache.match(stableKey);
      if (cached && isCacheableFullResponse(cached)) return cached;
      if (cached) await cache.delete(stableKey).catch(() => {});
    } catch {
      cache = null;
    }
  }

  const response = await fetchSource();
  if (!response.ok) throw new Error(`Blob fetch failed: ${response.status}`);

  if (cache && isCacheableFullResponse(response)) {
    await cache.put(stableKey, response.clone()).catch(() => {});
  }
  return response;
}

export async function putCachedBlob(stableKey: string, response: Response): Promise<void> {
  if (!canUseCacheStorage() || !isCacheableFullResponse(response)) return;
  const cache = await caches.open(BLOB_CACHE_NAME).catch(() => null);
  await cache?.put(stableKey, response.clone()).catch(() => {});
}

export async function evictCachedBlobPrefix(prefix: string): Promise<void> {
  if (!canUseCacheStorage()) return;
  const cache = await caches.open(BLOB_CACHE_NAME).catch(() => null);
  if (!cache) return;
  const keys = await cache.keys().catch(() => []);
  await Promise.allSettled(keys.filter((request) => new URL(request.url).pathname.startsWith(prefix)).map((request) => cache.delete(request)));
}

export async function clearBlobCache(): Promise<void> {
  if (!canUseCacheStorage()) return;
  await caches.delete(BLOB_CACHE_NAME).catch(() => {});
}

export function documentBlobCacheKey(documentId: string, contentVersion: string): string {
  return `/openreader-cache/documents/${encodeURIComponent(documentId)}/${encodeURIComponent(contentVersion)}`;
}

export function previewBlobCacheKey(documentId: string, previewVersion: string | number): string {
  return `/openreader-cache/previews/${encodeURIComponent(documentId)}/${encodeURIComponent(String(previewVersion))}`;
}

export function audioBlobCacheKey(audioKey: string, version: string | number): string {
  return `/openreader-cache/audio/${encodeURIComponent(audioKey)}/${encodeURIComponent(String(version))}`;
}
