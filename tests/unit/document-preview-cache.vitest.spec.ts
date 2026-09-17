import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getCachedBlob: vi.fn(),
}));

vi.mock('@/lib/client/cache/blob-cache', () => ({
  getCachedBlob: hoisted.getCachedBlob,
  previewBlobCacheKey: vi.fn((id: string, version: string | number) => `${id}:${version}`),
  evictCachedBlobPrefix: vi.fn(async () => undefined),
}));

describe('document preview cache', () => {
  beforeEach(() => {
    hoisted.getCachedBlob.mockReset();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    const { clearInMemoryDocumentPreviewCache } = await import('@/lib/client/cache/previews');
    clearInMemoryDocumentPreviewCache();
    vi.restoreAllMocks();
  });

  test('does not turn a pending 202 JSON response into an image blob URL', async () => {
    hoisted.getCachedBlob.mockResolvedValue(Response.json(
      { status: 'queued', opId: 'preview-op-1' },
      { status: 202 },
    ));
    const { primeDocumentPreviewCache } = await import('@/lib/client/cache/previews');

    await expect(primeDocumentPreviewCache('doc-1', 1, 'doc-1:1')).resolves.toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  test('accepts a completed image response', async () => {
    hoisted.getCachedBlob.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }));
    const { primeDocumentPreviewCache } = await import('@/lib/client/cache/previews');

    await expect(primeDocumentPreviewCache('doc-2', 2, 'doc-2:2')).resolves.toBe('blob:preview-image');
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  test('bounds versioned in-memory preview URLs', async () => {
    const {
      getInMemoryDocumentPreviewUrl,
      setInMemoryDocumentPreviewUrl,
    } = await import('@/lib/client/cache/previews');

    // One past the in-memory cap (300) to force a single LRU eviction.
    for (let index = 0; index <= 300; index += 1) {
      setInMemoryDocumentPreviewUrl(`doc-${index}:1`, `blob:preview-${index}`);
    }

    expect(getInMemoryDocumentPreviewUrl('doc-0:1')).toBeNull();
    expect(getInMemoryDocumentPreviewUrl('doc-300:1')).toBe('blob:preview-300');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-0');
  });
});
