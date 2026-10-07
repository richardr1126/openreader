import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createDocumentBookmark,
  deleteDocumentBookmark,
  listDocumentBookmarks,
  renameDocumentBookmark,
} from '@/lib/client/api/bookmarks';
import { importGutenbergBook } from '@/lib/client/api/documents';
import { ApiError } from '@/lib/client/api/http';

const DOC = 'a'.repeat(64);
const MARK = '0f8fad5b-d9cb-469f-a165-70867728950e';

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('bookmarks client API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('calls the document-scoped routes with the expected methods and bodies', async () => {
    const bookmark = { id: MARK, documentId: DOC, readerType: 'pdf', location: '1:0', snippet: 's' };
    const fetchMock = stubFetch((url, init) => {
      if (init?.method === 'DELETE') return Response.json({ deleted: true });
      if (init?.method === 'POST' || init?.method === 'PATCH') return Response.json({ bookmark });
      return Response.json({ bookmarks: [bookmark] });
    });

    await expect(listDocumentBookmarks(DOC)).resolves.toEqual([bookmark]);
    await createDocumentBookmark(DOC, { readerType: 'pdf', location: '1:0', snippet: 's' });
    await renameDocumentBookmark(DOC, MARK, 'Named');
    await expect(deleteDocumentBookmark(DOC, MARK)).resolves.toBe(true);

    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      [`/api/documents/${DOC}/bookmarks`, 'GET'],
      [`/api/documents/${DOC}/bookmarks`, 'POST'],
      [`/api/documents/${DOC}/bookmarks/${MARK}`, 'PATCH'],
      [`/api/documents/${DOC}/bookmarks/${MARK}`, 'DELETE'],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ label: 'Named' });
  });

  test('surfaces the server error message', async () => {
    stubFetch(() => Response.json({ error: 'Not found' }, { status: 404 }));
    const failure = await listDocumentBookmarks(DOC).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(404);
    expect((failure as ApiError).message).toBe('Not found');
  });
});

describe('import metadata hints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a Gutenberg import forwards catalog author and language to finalize', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === '/api/gutenberg/import') {
        return Response.json({
          token: '123e4567-e89b-12d3-a456-426614174000',
          name: 'Pride and Prejudice.epub',
          type: 'epub',
          lastModified: 5,
          author: 'Jane Austen',
          language: 'en',
        });
      }
      return Response.json({ stored: [] });
    });

    await importGutenbergBook(1342);
    const finalize = fetchMock.mock.calls.find(([url]) => String(url) === '/api/documents/blob/upload/finalize');
    expect(JSON.parse(String(finalize?.[1]?.body)).uploads[0]).toMatchObject({
      author: 'Jane Austen',
      language: 'en',
    });
  });
});
