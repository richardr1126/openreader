import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  let stored: { valueJson: unknown } | null = null;
  return {
    reset: () => { stored = null; },
    read: () => stored,
    db: {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ limit: async () => stored ? [stored] : [] }),
        }),
      })),
      insert: vi.fn(() => ({
        values: (value: { valueJson: unknown }) => ({
          onConflictDoUpdate: async () => { stored = value; },
          onConflictDoNothing: async () => { stored = value; },
        }),
      })),
    },
    encryptSecret: vi.fn((value: string) => ({ ciphertext: `encrypted:${value}`, iv: 'iv' })),
    decryptSecret: vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted:/, '')),
    requireAuthContext: vi.fn(),
    putTempDocumentBlob: vi.fn(),
  };
});

vi.mock('@openreader/database', () => ({ db: mocks.db }));
vi.mock('@/lib/server/crypto/secrets', () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: mocks.decryptSecret,
}));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: mocks.requireAuthContext }));
vi.mock('@/lib/server/documents/blobstore', () => ({ putTempDocumentBlob: mocks.putTempDocumentBlob }));
vi.mock('@/lib/server/storage/s3', () => ({ isS3Configured: () => true }));
vi.mock('@/lib/server/runtime-config', () => ({
  getResolvedRuntimeConfig: async () => ({ maxUploadMb: 1 }),
}));

import {
  getGutendexSettings,
  normalizeGutendexServerUrl,
  parseGutendexSettingsSeed,
  seedGutendexSettings,
  updateGutendexSettings,
} from '../../src/lib/server/admin/gutendex-settings';
import { downloadGutenbergEpub, searchGutenberg } from '../../src/lib/server/documents/gutenberg';
import { GET as searchBooks } from '../../src/app/api/gutenberg/books/route';
import { POST as importBook } from '../../src/app/api/gutenberg/import/route';

const fetchMock = vi.fn<typeof fetch>();

function storedValue(): Record<string, unknown> {
  const value = mocks.read()?.valueJson;
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

const prideAndPrejudice = {
  id: 1342,
  title: 'Pride and Prejudice',
  authors: [{ name: 'Austen, Jane' }],
  languages: ['en'],
  download_count: 90000,
  formats: {
    'application/epub+zip': 'https://www.gutenberg.org/ebooks/1342.epub3.images',
    'image/jpeg': 'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg',
  },
};

beforeEach(() => {
  mocks.reset();
  fetchMock.mockReset();
  mocks.putTempDocumentBlob.mockReset();
  mocks.requireAuthContext.mockReset();
  mocks.requireAuthContext.mockResolvedValue({ userId: 'user-1' });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gutendex settings', () => {
  test('defaults to the public server, enabled, with no key', async () => {
    await expect(getGutendexSettings()).resolves.toEqual({
      enabled: true,
      serverUrl: 'https://gutendex.com',
      apiKey: null,
    });
  });

  test('stores the server root whichever form of the address is pasted', () => {
    expect(normalizeGutendexServerUrl('gutendex.example.com')).toBe('https://gutendex.example.com');
    expect(normalizeGutendexServerUrl('https://gutendex.example.com/books/')).toBe('https://gutendex.example.com');
    expect(normalizeGutendexServerUrl('http://10.0.0.5:8000/catalog/books')).toBe('http://10.0.0.5:8000/catalog');
    expect(() => normalizeGutendexServerUrl('ftp://gutendex.example.com')).toThrow(/http or https/);
    expect(() => normalizeGutendexServerUrl('https://user:key@gutendex.example.com')).toThrow(/own field/);
  });

  test('encrypts the API key at rest and only exposes its mask', async () => {
    const publicSettings = await updateGutendexSettings({
      serverUrl: 'https://gutendex.example.com/books/',
      apiKey: 'gutendex-secret-key',
    });

    expect(JSON.stringify(storedValue())).not.toContain('"gutendex-secret-key"');
    expect(storedValue()).toMatchObject({ serverUrl: 'https://gutendex.example.com', apiKeyLast4: '-key' });
    expect(publicSettings).toEqual({
      enabled: true,
      serverUrl: 'https://gutendex.example.com',
      apiKeyConfigured: true,
      apiKeyMask: '••••-key',
    });
    await expect(getGutendexSettings()).resolves.toMatchObject({ apiKey: 'gutendex-secret-key' });

    await updateGutendexSettings({ apiKey: null });
    await expect(getGutendexSettings()).resolves.toMatchObject({ apiKey: null });
  });

  test('refuses to send a key to a plain http server', async () => {
    await expect(updateGutendexSettings({ serverUrl: 'http://10.0.0.5:8000' })).resolves.toMatchObject({
      serverUrl: 'http://10.0.0.5:8000',
    });
    await expect(updateGutendexSettings({ apiKey: 'gutendex-secret-key' })).rejects.toThrow(/https/);
    await expect(seedGutendexSettings(parseGutendexSettingsSeed({
      serverUrl: 'http://10.0.0.5:8000',
      apiKey: 'gutendex-secret-key',
    }))).rejects.toThrow(/https/);
  });

  test('seeds from the runtime JSON and rejects unknown keys', async () => {
    const seed = parseGutendexSettingsSeed({ serverUrl: 'gutendex.example.com', apiKey: 'seeded-key' });
    expect(seed).toEqual({ enabled: true, serverUrl: 'https://gutendex.example.com', apiKey: 'seeded-key' });
    await expect(seedGutendexSettings(seed)).resolves.toBe(true);
    await expect(getGutendexSettings()).resolves.toEqual({
      enabled: true,
      serverUrl: 'https://gutendex.example.com',
      apiKey: 'seeded-key',
    });
    // An existing row, seeded or edited, always wins over a later seed.
    await expect(seedGutendexSettings(seed)).resolves.toBe(false);

    expect(() => parseGutendexSettingsSeed({ serverUrl: 'https://gutendex.com', url: 'x' })).toThrow(/unknown keys: url/);
  });
});

describe('gutenberg catalog', () => {
  test('searches the configured server with its key and trims the results', async () => {
    await updateGutendexSettings({ serverUrl: 'https://gutendex.example.com', apiKey: 'gutendex-secret-key' });
    fetchMock.mockResolvedValue(json({ count: 1, next: 'https://gutendex.example.com/books/?page=2', results: [prideAndPrejudice] }));

    const page = await searchGutenberg({ search: 'austen', page: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://gutendex.example.com/books/?search=austen&copyright=false&mime_type=application%2Fepub');
    expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('gutendex-secret-key');
    expect(page).toEqual({
      count: 1,
      page: 1,
      hasNextPage: true,
      books: [{
        id: 1342,
        title: 'Pride and Prejudice',
        authors: ['Jane Austen'],
        languages: ['en'],
        downloadCount: 90000,
        coverUrl: 'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg',
      }],
    });
  });

  test('filters by language, and the route refuses anything but a language code', async () => {
    fetchMock.mockResolvedValue(json({ count: 0, next: null, results: [] }));
    await searchGutenberg({ search: '', page: 2, language: 'fr' });
    expect(String(fetchMock.mock.calls[0]![0]))
      .toBe('https://gutendex.com/books/?languages=fr&copyright=false&mime_type=application%2Fepub&page=2');

    const refused = await searchBooks(new NextRequest('http://localhost/api/gutenberg/books?language=fr%2Cen%26x%3D1'));
    expect(refused.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('asks once more when the catalog turns a request away under load', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(json({ count: 0, next: null, results: [] }));
    await expect(searchGutenberg({ search: '', page: 1 })).resolves.toMatchObject({ count: 0 });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(searchGutenberg({ search: '', page: 1 })).rejects.toThrow(/returned 503/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not follow a catalog redirect that would carry the key elsewhere', async () => {
    await updateGutendexSettings({ serverUrl: 'https://gutendex.example.com', apiKey: 'gutendex-secret-key' });
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/books/?page=1' } }))
      .mockResolvedValueOnce(json({ count: 0, next: null, results: [] }));
    await expect(searchGutenberg({ search: '', page: 1 })).resolves.toMatchObject({ count: 0 });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://attacker.example/books/' } }));
    await expect(searchGutenberg({ search: '', page: 1 })).rejects.toThrow(/redirected away/);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://gutendex.example.com/books/' } }));
    await expect(searchGutenberg({ search: '', page: 1 })).rejects.toThrow(/redirected away/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('sends no key header when none is configured', async () => {
    fetchMock.mockResolvedValue(json({ count: 0, next: null, results: [] }));
    await searchGutenberg({ search: '', page: 1 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers as Record<string, string>).not.toHaveProperty('X-API-Key');
  });

  test('refuses to search when an admin has turned the catalog off', async () => {
    await updateGutendexSettings({ enabled: false });
    await expect(searchGutenberg({ search: '', page: 1 })).rejects.toMatchObject({ httpStatus: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('follows Gutenberg redirects but never leaves gutenberg.org', async () => {
    fetchMock
      .mockResolvedValueOnce(json(prideAndPrejudice))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/cache/epub/1342/pg1342-images-3.epub' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 3, 4])));

    const result = await downloadGutenbergEpub(1342, 1024);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://gutendex.com/books/1342/');
    expect(String(fetchMock.mock.calls[2]![0])).toBe('https://www.gutenberg.org/cache/epub/1342/pg1342-images-3.epub');
    expect(result.name).toBe('Pride and Prejudice.epub');
    expect(result.bytes.byteLength).toBe(4);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(json(prideAndPrejudice))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
    await expect(downloadGutenbergEpub(1342, 1024)).rejects.toThrow(/outside Project Gutenberg/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('will not import a book still under copyright', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...prideAndPrejudice, copyright: true }));
    await expect(downloadGutenbergEpub(1342, 1024)).rejects.toMatchObject({ httpStatus: 422 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('stops reading a book that is over the upload limit', async () => {
    fetchMock
      .mockResolvedValueOnce(json(prideAndPrejudice))
      .mockResolvedValueOnce(new Response(new Uint8Array(2048)));
    await expect(downloadGutenbergEpub(1342, 1024)).rejects.toMatchObject({ httpStatus: 413 });
  });
});

describe('gutenberg import route', () => {
  test('stages the book as the caller\'s temp upload for the finalize step', async () => {
    fetchMock
      .mockResolvedValueOnce(json(prideAndPrejudice))
      .mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 3, 4])));

    const response = await importBook(new NextRequest('http://localhost/api/gutenberg/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1342 }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { token: string; name: string; type: string };
    expect(body).toMatchObject({ name: 'Pride and Prejudice.epub', type: 'epub' });
    expect(mocks.putTempDocumentBlob).toHaveBeenCalledWith(
      body.token,
      'user-1',
      expect.any(Buffer),
      'application/epub+zip',
      null,
    );
  });

  test('takes a catalog id only, never a URL', async () => {
    const response = await importBook(new NextRequest('http://localhost/api/gutenberg/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'https://example.com/book.epub' }),
    }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
