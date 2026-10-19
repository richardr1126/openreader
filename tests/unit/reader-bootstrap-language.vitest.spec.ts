import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveReaderBootstrapState } from '@/lib/server/reader/bootstrap';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';

const mocks = vi.hoisted(() => ({
  limit: vi.fn(), set: vi.fn(), playback: vi.fn(), pdf: vi.fn(), object: vi.fn(), scope: vi.fn(),
}));
vi.mock('@openreader/database', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }),
  update: () => ({ set: mocks.set }),
} }));
vi.mock('@/lib/server/tts/segments-auth', () => ({
  resolveSegmentDocumentScope: mocks.scope,
}));
vi.mock('@/lib/server/pdf-parse/operation', () => ({ resolveCurrentPdfParse: mocks.pdf }));
vi.mock('@/lib/server/storage/s3', () => ({
  getS3InternalClient: () => ({ send: mocks.object }), getS3Config: () => ({ bucket: 'test' }),
}));
vi.mock('@/lib/server/reader/playback', () => ({ resolveReaderPlayback: mocks.playback }));

const turkish = readFileSync('tests/files/turkish-sample.txt', 'utf8');
const request = new NextRequest('http://localhost/api/documents/book/reader-bootstrap');

function parsed(texts: string[]): ParsedPdfDocument {
  return {
    schemaVersion: 1, documentId: 'book', parserVersion: 'test', parsedAt: 1,
    pages: [{ pageNumber: 1, width: 600, height: 800,
      blocks: texts.map((text, index) => ({ id: `block-${index}`, kind: 'text', text, fragments: [] })),
    }],
  };
}

function rows(language: string | null = null, type = 'pdf') {
  mocks.scope.mockResolvedValue({
    storageUserId: 'owner', userId: 'owner', isAnonymousUser: false,
    documentVersion: 1, readerType: type, documentName: `book.${type}`,
  });
  mocks.limit.mockResolvedValueOnce([{
    id: 'book', userId: 'owner', type, name: `book.${type}`, size: 100,
    lastModified: 1, folderId: null, recentlyOpenedAt: null, author: null, language,
  }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.pdf.mockResolvedValue({ artifact: { objectKey: 'parsed/book.json' }, operation: null });
  mocks.object.mockResolvedValue({ Body: { transformToString: async () => JSON.stringify(parsed([turkish])) } });
  mocks.playback.mockResolvedValue({ plan: {}, playback: {} });
  mocks.set.mockReturnValue({ where: async () => undefined });
});

describe('document language in reader bootstrap', () => {
  test('detects a PDF without metadata before planning, returns it, and persists it', async () => {
    rows();
    const result = await resolveReaderBootstrapState(request, 'book');
    expect(mocks.playback.mock.calls[0]?.[5]).toBe('tr');
    expect(result).toMatchObject({ result: { status: 'ready', payload: { document: { language: 'tr' } } } });
    expect(mocks.set).toHaveBeenCalledWith({ recentlyOpenedAt: expect.any(Number), language: 'tr' });

    rows('tr');
    mocks.object.mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify(parsed(['unknown'])) } });
    await resolveReaderBootstrapState(request, 'book');
    expect(mocks.playback.mock.calls[1]?.[5]).toBe('tr');
    expect(mocks.set.mock.calls[1]?.[0]).not.toHaveProperty('language');
  });

  test.each(['de-DE', 'en-GB'])('preserves existing PDF metadata %s instead of guessing Turkish', async (language) => {
    rows(language);
    const result = await resolveReaderBootstrapState(request, 'book');
    expect(mocks.playback.mock.calls[0]?.[5]).toBe(language);
    expect(result).toMatchObject({ result: { payload: { document: { language } } } });
    expect(mocks.set.mock.calls[0]?.[0]).not.toHaveProperty('language');
  });

  test.each(['epub', 'html'])('passes imported %s metadata to playback', async (type) => {
    rows('tr-TR', type);
    await resolveReaderBootstrapState(request, 'book');
    expect(mocks.playback.mock.calls[0]?.[5]).toBe('tr-TR');
  });

  test('leaves an unknown PDF unset so it can be detected on a later open', async () => {
    rows();
    mocks.object.mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify(parsed(['Chapter 1'])) } });
    const result = await resolveReaderBootstrapState(request, 'book');
    expect(mocks.playback.mock.calls[0]?.[5]).toBeNull();
    expect(mocks.set.mock.calls[0]?.[0]).not.toHaveProperty('language');
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response || result.result.status !== 'ready') throw new Error('Expected ready PDF');
    expect(result.result.payload.document.language).toBeUndefined();
  });

  test('persists English rather than Turkish when an untagged PDF mentions Işık', async () => {
    rows();
    const english = 'The book was by Işık and it was in the house. He read it to her as they sat by the fire.';
    mocks.object.mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify(parsed([english])) } });
    const result = await resolveReaderBootstrapState(request, 'book');
    expect(mocks.playback.mock.calls[0]?.[5]).toBe('en');
    expect(mocks.set).toHaveBeenCalledWith({ recentlyOpenedAt: expect.any(Number), language: 'en' });
    expect(result).toMatchObject({ result: { payload: { document: { language: 'en' } } } });
  });

  test('bounds PDF text sampling to the first 60k characters', async () => {
    rows();
    const english = 'The book is in the house and it was there that she had read the story. '.repeat(1_000);
    mocks.object.mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify(parsed([english, turkish.repeat(200)])) } });
    await resolveReaderBootstrapState(request, 'book');
    expect(mocks.playback.mock.calls[0]?.[5]).toBe('en');
  });
});
