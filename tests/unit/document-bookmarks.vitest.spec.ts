import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseBookmarkCreateBody } from '@/lib/server/documents/bookmarks';
import { serializeReaderPosition } from '@/lib/shared/reader-position';

const state = vi.hoisted(() => ({
  sqlite: null as unknown as import('better-sqlite3').Database,
  db: null as unknown,
  userId: 'reader' as string | null,
}));

vi.mock('@openreader/database', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: vi.fn(async () => ({ userId: state.userId })),
}));
vi.mock('@/lib/server/storage/s3', () => ({ isS3Configured: () => true }));
vi.mock('@/lib/server/documents/delete-owned', () => ({ deleteOwnedDocument: vi.fn() }));

import { GET as listBookmarks, POST as createBookmark } from '@/app/api/documents/[id]/bookmarks/route';
import {
  DELETE as deleteBookmark,
  PATCH as renameBookmark,
} from '@/app/api/documents/[id]/bookmarks/[bookmarkId]/route';
import { GET as listDocuments } from '@/app/api/documents/route';

const PDF_ID = 'a'.repeat(64);
const EPUB_ID = 'b'.repeat(64);
const OTHER_USERS_ID = 'c'.repeat(64);

const migration = readFileSync(
  join(process.cwd(), 'packages/database/migrations/sqlite/0021_ios_parity.sql'),
  'utf8',
);

/** The pre-migration shape of the tables the ios_parity migration touches. */
function createDatabase() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE user (id text PRIMARY KEY NOT NULL);
    CREATE TABLE documents (
      id text NOT NULL,
      user_id text NOT NULL REFERENCES user(id) ON DELETE cascade,
      name text NOT NULL,
      type text NOT NULL,
      size integer NOT NULL,
      last_modified integer NOT NULL,
      file_path text NOT NULL,
      folder_id text,
      recently_opened_at integer,
      created_at integer,
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE user_document_progress (
      user_id text NOT NULL,
      document_id text NOT NULL,
      reader_type text NOT NULL,
      location text NOT NULL,
      progress real,
      client_updated_at_ms integer NOT NULL DEFAULT 0,
      created_at integer,
      updated_at integer,
      PRIMARY KEY (user_id, document_id)
    );
  `);
  sqlite.exec(migration);
  sqlite.exec(`
    INSERT INTO user (id) VALUES ('reader'), ('someone-else');
    INSERT INTO documents (id, user_id, name, type, size, last_modified, file_path, author, language)
    VALUES
      ('${PDF_ID}', 'reader', 'paper.pdf', 'pdf', 10, 1, '${PDF_ID}', 'Ada Lovelace', 'en'),
      ('${EPUB_ID}', 'reader', 'book.epub', 'epub', 20, 2, '${EPUB_ID}', NULL, NULL),
      ('${OTHER_USERS_ID}', 'someone-else', 'theirs.pdf', 'pdf', 30, 3, '${OTHER_USERS_ID}', NULL, NULL);
  `);
  return sqlite;
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
}

const docParams = (id: string) => ({ params: Promise.resolve({ id }) });
const bookmarkParams = (id: string, bookmarkId: string) => ({ params: Promise.resolve({ id, bookmarkId }) });

async function create(documentId: string, body: unknown) {
  return createBookmark(jsonRequest(`/api/documents/${documentId}/bookmarks`, 'POST', body), docParams(documentId));
}

describe('document bookmarks API', () => {
  beforeEach(() => {
    state.sqlite = createDatabase();
    state.db = drizzle(state.sqlite);
    state.userId = 'reader';
  });

  afterEach(() => {
    state.sqlite.close();
  });

  test('creates, lists newest first, renames, and deletes a PDF bookmark', async () => {
    const first = await create(PDF_ID, {
      readerType: 'pdf',
      location: serializeReaderPosition('pdf', 3, 12),
      snippet: '  The   first   marked sentence. ',
      segmentKey: 'v7:abc',
      segmentOrdinal: 12,
    });
    expect(first.status).toBe(201);
    const { bookmark } = await first.json();
    expect(bookmark).toMatchObject({
      documentId: PDF_ID,
      readerType: 'pdf',
      location: '3:12',
      snippet: 'The first marked sentence.',
      label: null,
      segmentKey: 'v7:abc',
      segmentOrdinal: 12,
    });

    // Distinct creation times make the newest-first order observable.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await create(PDF_ID, { readerType: 'pdf', location: '5:40', snippet: 'Later', label: 'Key idea' });

    const listed = await (await listBookmarks(jsonRequest(`/api/documents/${PDF_ID}/bookmarks`, 'GET'), docParams(PDF_ID))).json();
    expect(listed.bookmarks.map((item: { snippet: string }) => item.snippet)).toEqual(['Later', 'The first marked sentence.']);

    const renamed = await renameBookmark(
      jsonRequest(`/api/documents/${PDF_ID}/bookmarks/${bookmark.id}`, 'PATCH', { label: ' Chapter start ' }),
      bookmarkParams(PDF_ID, bookmark.id),
    );
    expect((await renamed.json()).bookmark.label).toBe('Chapter start');

    const cleared = await renameBookmark(
      jsonRequest(`/api/documents/${PDF_ID}/bookmarks/${bookmark.id}`, 'PATCH', { label: null }),
      bookmarkParams(PDF_ID, bookmark.id),
    );
    expect((await cleared.json()).bookmark.label).toBeNull();

    const deleted = await deleteBookmark(
      jsonRequest(`/api/documents/${PDF_ID}/bookmarks/${bookmark.id}`, 'DELETE'),
      bookmarkParams(PDF_ID, bookmark.id),
    );
    expect(await deleted.json()).toEqual({ deleted: true });
    const again = await deleteBookmark(
      jsonRequest(`/api/documents/${PDF_ID}/bookmarks/${bookmark.id}`, 'DELETE'),
      bookmarkParams(PDF_ID, bookmark.id),
    );
    expect(await again.json()).toEqual({ deleted: false });
  });

  test('stores EPUB locators in the progress encoding and returns them structured', async () => {
    const locator = { schemaVersion: 1, spineHref: 'ch02.xhtml', spineIndex: 2, charOffset: 140 };
    const response = await create(EPUB_ID, { readerType: 'epub', locator, snippet: 'Call me Ishmael.' });
    expect(response.status).toBe(201);
    expect((await response.json()).bookmark.locator).toEqual(locator);
    const stored = state.sqlite.prepare('SELECT location FROM user_document_bookmarks').get() as { location: string };
    expect(stored.location.startsWith('epub:v1:')).toBe(true);
  });

  test('a client-supplied id makes create idempotent', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const body = { id, readerType: 'pdf', location: '1:0', snippet: 'Once' };
    expect((await create(PDF_ID, body)).status).toBe(201);
    const retry = await create(PDF_ID, { ...body, snippet: 'Twice' });
    expect(retry.status).toBe(200);
    expect((await retry.json()).bookmark.snippet).toBe('Once');
    expect((await create(EPUB_ID, { ...body, readerType: 'epub', locator: { schemaVersion: 1, spineHref: 'a', spineIndex: 0, charOffset: 0 } })).status).toBe(409);
  });

  test('rejects invalid input, mismatched readers, and documents the user does not own', async () => {
    expect((await create(PDF_ID, { readerType: 'pdf', location: 'nonsense', snippet: 'x' })).status).toBe(400);
    expect((await create(PDF_ID, { readerType: 'epub', locator: { schemaVersion: 1, spineHref: 'a', spineIndex: 0, charOffset: 0 }, snippet: 'x' })).status).toBe(400);
    expect((await create(OTHER_USERS_ID, { readerType: 'pdf', location: '1:0', snippet: 'x' })).status).toBe(404);
    state.userId = null;
    expect((await create(PDF_ID, { readerType: 'pdf', location: '1:0', snippet: 'x' })).status).toBe(401);
  });

  test('bookmarks are hard-deleted with their document row', async () => {
    await create(PDF_ID, { readerType: 'pdf', location: '1:0', snippet: 'Gone soon' });
    state.sqlite.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(PDF_ID, 'reader');
    expect(state.sqlite.prepare('SELECT count(*) AS n FROM user_document_bookmarks').get()).toEqual({ n: 0 });
  });

  test('document list carries author, language, and reading progress without N+1 queries', async () => {
    state.sqlite.prepare(`
      INSERT INTO user_document_progress (user_id, document_id, reader_type, location, progress, updated_at)
      VALUES ('reader', ?, 'pdf', '2:0', 0.42, 1234)
    `).run(PDF_ID);
    const response = await listDocuments(jsonRequest('/api/documents', 'GET'));
    const { documents } = await response.json();
    const byId = Object.fromEntries(documents.map((doc: { id: string }) => [doc.id, doc]));
    expect(byId[PDF_ID]).toMatchObject({
      author: 'Ada Lovelace',
      language: 'en',
      readingProgress: { fraction: 0.42, updatedAtMs: 1234 },
    });
    expect(byId[EPUB_ID].author).toBeUndefined();
    expect(byId[EPUB_ID].readingProgress).toBeUndefined();
    expect(byId[OTHER_USERS_ID]).toBeUndefined();
  });
});

describe('parseBookmarkCreateBody', () => {
  test('bounds label and snippet length and validates anchors', () => {
    const parsed = parseBookmarkCreateBody({
      readerType: 'html',
      location: serializeReaderPosition('html', 'section-2', 4),
      snippet: 'x'.repeat(900),
      label: 'y'.repeat(300),
    });
    expect(parsed.ok && parsed.value.snippet.length).toBe(500);
    expect(parsed.ok && parsed.value.label?.length).toBe(200);
    expect(parseBookmarkCreateBody({ readerType: 'pdf', location: '1:0', snippet: 'x', segmentOrdinal: -1 }).ok).toBe(false);
    expect(parseBookmarkCreateBody({ readerType: 'pdf', location: '1:0', snippet: 'x', id: 'not-a-uuid' }).ok).toBe(false);
    expect(parseBookmarkCreateBody({ readerType: 'pdf', location: '1:0' }).ok).toBe(false);
  });
});
