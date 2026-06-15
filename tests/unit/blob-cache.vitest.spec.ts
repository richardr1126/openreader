import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  audioBlobCacheKey,
  audiobookChapterBlobCacheKey,
  documentBlobCacheKey,
  getCachedBlob,
  previewBlobCacheKey,
} from '../../src/lib/client/cache/blob-cache';
import {
  clearCachedAudioObjectUrls,
  getCachedAudioUrl,
} from '../../src/lib/client/cache/audio';

afterEach(() => {
  clearCachedAudioObjectUrls();
  vi.unstubAllGlobals();
});

describe('blob cache stable keys', () => {
  test('builds versioned synthetic keys', () => {
    expect(documentBlobCacheKey('doc/id', 'v1')).toBe('/openreader-cache/documents/doc%2Fid/v1');
    expect(previewBlobCacheKey('doc', 'etag/1')).toBe('/openreader-cache/previews/doc/etag%2F1');
    expect(audioBlobCacheKey('audio/key', 2)).toBe('/openreader-cache/audio/audio%2Fkey/2');
    expect(audiobookChapterBlobCacheKey('book/id', 2, 'v/1'))
      .toBe('/openreader-cache/audiobooks/book%2Fid/chapters/2/v%2F1');
  });

  test('returns a cache hit without fetching', async () => {
    const cached = new Response('cached');
    const match = vi.fn().mockResolvedValue(cached);
    vi.stubGlobal('window', {});
    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ match, put: vi.fn() }) });
    const fetchSource = vi.fn();

    expect(await (await getCachedBlob('/openreader-cache/documents/doc/v1', fetchSource)).text()).toBe('cached');
    expect(fetchSource).not.toHaveBeenCalled();
  });

  test('fetches and caches a successful full response on a miss', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {});
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({ match: vi.fn().mockResolvedValue(undefined), put }),
    });

    const response = await getCachedBlob('/openreader-cache/documents/doc/v2', async () => new Response('network'));
    expect(await response.text()).toBe('network');
    expect(put).toHaveBeenCalledOnce();
  });

  test('treats missing Cache Storage and cache write failures as non-fatal', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('caches', {
      open: vi.fn()
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockResolvedValueOnce({
          match: vi.fn().mockResolvedValue(undefined),
          put: vi.fn().mockRejectedValue(new Error('quota')),
        }),
    });

    expect(await (await getCachedBlob('/openreader-cache/documents/doc/v3', async () => new Response('first'))).text()).toBe('first');
    expect(await (await getCachedBlob('/openreader-cache/documents/doc/v4', async () => new Response('second'))).text()).toBe('second');
  });

  test('does not cache partial responses and throws for failed fetches', async () => {
    const put = vi.fn();
    vi.stubGlobal('window', {});
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({ match: vi.fn().mockResolvedValue(undefined), put }),
    });

    const partial = await getCachedBlob(
      '/openreader-cache/audio/key/v1',
      async () => new Response('partial', { status: 206, headers: { 'Content-Range': 'bytes 0-6/20' } }),
    );
    expect(partial.status).toBe(206);
    expect(put).not.toHaveBeenCalled();
    await expect(getCachedBlob('/openreader-cache/audio/key/v2', async () => new Response(null, { status: 404 })))
      .rejects.toThrow('Blob fetch failed: 404');
  });

  test('discards an invalid cached partial response before fetching the full blob', async () => {
    const deleteEntry = vi.fn().mockResolvedValue(true);
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {});
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(new Response('partial', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-6/20' },
        })),
        delete: deleteEntry,
        put,
      }),
    });

    const response = await getCachedBlob('/openreader-cache/audio/key/v3', async () => new Response('full'));
    expect(await response.text()).toBe('full');
    expect(deleteEntry).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
  });
});

describe('audio object URL lifecycle', () => {
  test('revokes the previous object URL when a server-owned audio version changes', async () => {
    const revokeObjectURL = vi.fn();
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('audio')));

    expect(await getCachedAudioUrl({
      audioKey: 'audio/key',
      version: 1,
      primaryUrl: '/first',
      fallbackUrl: null,
    })).toBe('blob:first');
    expect(await getCachedAudioUrl({
      audioKey: 'audio/key',
      version: 2,
      primaryUrl: '/second',
      fallbackUrl: null,
    })).toBe('blob:second');

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first');
  });
});
