import { audioBlobCacheKey, getCachedBlob } from '@/lib/client/cache/blob-cache';

const objectUrls = new Map<string, string>();

export async function getCachedAudioUrl(input: {
  audioKey: string;
  version: string | number;
  primaryUrl: string | null;
  fallbackUrl: string | null;
}): Promise<string> {
  const key = audioBlobCacheKey(input.audioKey, input.version);
  const existing = objectUrls.get(key);
  if (existing) return existing;
  const response = await getCachedBlob(key, async () => {
    const primary = input.primaryUrl ? await fetch(input.primaryUrl).catch(() => null) : null;
    if (primary?.ok) return primary;
    if (!input.fallbackUrl) return primary ?? new Response(null, { status: 404 });
    return fetch(input.fallbackUrl);
  });
  const url = URL.createObjectURL(await response.blob());
  objectUrls.set(key, url);
  return url;
}

export function clearCachedAudioObjectUrls(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}
