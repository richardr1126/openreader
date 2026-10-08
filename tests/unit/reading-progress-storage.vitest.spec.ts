import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveReadingPositionOrdinal } from '@/lib/shared/reading-position';

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

import { GET as getProgress, PUT as putProgress } from '@/app/api/user/state/progress/route';

const migration = readFileSync(
  join(process.cwd(), 'packages/database/migrations/sqlite/0021_ios_parity.sql'),
  'utf8',
);

const DOC = (char: string) => char.repeat(64);

/** Released v5.0 progress rows, then the ios_parity migration. */
function migratedDatabase(rows: Array<[documentId: string, readerType: string, location: string, progress: number | null]>) {
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
      user_id text NOT NULL REFERENCES user(id) ON DELETE cascade,
      document_id text NOT NULL,
      reader_type text NOT NULL,
      location text NOT NULL,
      progress real,
      client_updated_at_ms integer NOT NULL DEFAULT 0,
      created_at integer,
      updated_at integer,
      PRIMARY KEY (user_id, document_id)
    );
    INSERT INTO user (id) VALUES ('reader');
  `);
  const insert = sqlite.prepare(`
    INSERT INTO user_document_progress (user_id, document_id, reader_type, location, progress, client_updated_at_ms, updated_at)
    VALUES ('reader', ?, ?, ?, ?, 100, 200)
  `);
  for (const row of rows) insert.run(...row);
  sqlite.exec(migration);
  return sqlite;
}

function storedRows(sqlite: import('better-sqlite3').Database) {
  return Object.fromEntries((sqlite.prepare(`
    SELECT document_id AS documentId, segment_key AS segmentKey, segment_ordinal AS segmentOrdinal, progress
    FROM user_document_progress
  `).all() as Array<{ documentId: string; segmentKey: string | null; segmentOrdinal: number; progress: number | null }>)
    .map(({ documentId, ...rest }) => [documentId, rest]));
}

describe('ios_parity progress conversion', () => {
  test('keeps the ordinal embedded in v5.0 PDF and HTML tokens', () => {
    const sqlite = migratedDatabase([
      [DOC('a'), 'pdf', '12:7', 0.4],
      [DOC('b'), 'html', 'html:section%3Aintro:4', null],
      [DOC('c'), 'html', 'html:1:0', null],
      [DOC('d'), 'pdf', '3:123456789', null],
    ]);
    expect(storedRows(sqlite)).toEqual({
      [DOC('a')]: { segmentKey: null, segmentOrdinal: 7, progress: expect.closeTo(0.4) },
      [DOC('b')]: { segmentKey: null, segmentOrdinal: 4, progress: null },
      [DOC('c')]: { segmentKey: null, segmentOrdinal: 0, progress: null },
      [DOC('d')]: { segmentKey: null, segmentOrdinal: 123456789, progress: null },
    });
    sqlite.close();
  });

  test('starts EPUB locators and unrecognised legacy values from the beginning, keeping the row', () => {
    const epubLocator = `epub:v1:${encodeURIComponent(JSON.stringify({
      schemaVersion: 1, spineHref: 'ch02.xhtml', spineIndex: 2, charOffset: 140,
    }))}`;
    const sqlite = migratedDatabase([
      [DOC('a'), 'epub', epubLocator, 0.3],
      [DOC('b'), 'epub', 'epubcfi(/6/4!/4/2)', null],
      [DOC('c'), 'pdf', '12', null],
      [DOC('d'), 'pdf', 'abc:3', null],
      [DOC('e'), 'html', 'html:a:b:3', null],
      [DOC('f'), 'pdf', '1:99999999999', null],
    ]);
    const rows = storedRows(sqlite);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(rows[DOC(id)]).toMatchObject({ segmentKey: null, segmentOrdinal: 0 });
    }
    expect(rows[DOC('a')].progress).toBeCloseTo(0.3);
    const columns = (sqlite.prepare("SELECT name FROM pragma_table_info('user_document_progress')").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(columns).not.toContain('reader_type');
    expect(columns).not.toContain('location');
    sqlite.close();
  });

  test('the full migration chain ends with only the segment cursor columns', () => {
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), {
      migrationsFolder: join(process.cwd(), 'packages/database/migrations/sqlite'),
    });
    const columns = (table: string) => (sqlite.prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns('user_document_progress')).toEqual(expect.arrayContaining(['segment_key', 'segment_ordinal', 'progress']));
    expect(columns('user_document_progress')).not.toContain('location');
    expect(columns('user_document_bookmarks')).toEqual(expect.arrayContaining(['segment_key', 'segment_ordinal', 'snippet', 'label']));
    expect(columns('user_document_bookmarks')).not.toContain('reader_type');
    expect(columns('documents')).toEqual(expect.arrayContaining(['author', 'language']));
    sqlite.close();
  });

  test('a converted position resumes at its ordinal in the loaded plan', () => {
    const sqlite = migratedDatabase([[DOC('a'), 'pdf', '2:3', null]]);
    const plan = [0, 1, 2, 3, 4].map((ordinal) => ({ key: `v7:${ordinal}`, ordinal }));
    expect(resolveReadingPositionOrdinal(plan, storedRows(sqlite)[DOC('a')])).toBe(3);
    sqlite.close();
  });
});

function request(method: string, body?: unknown, query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/user/state/progress${query}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
}

describe('progress route', () => {
  beforeEach(() => {
    state.sqlite = migratedDatabase([[DOC('a'), 'pdf', '2:3', 0.1]]);
    state.db = drizzle(state.sqlite);
    state.userId = 'reader';
  });

  afterEach(() => {
    state.sqlite.close();
  });

  test('round-trips the playback cursor', async () => {
    const put = await putProgress(request('PUT', {
      documentId: DOC('b'),
      segmentKey: 'v7:abc',
      segmentOrdinal: 12,
      progress: 0.25,
      clientUpdatedAtMs: 1_000,
    }));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ applied: true });

    const got = await (await getProgress(request('GET', undefined, `?documentId=${DOC('b')}`))).json();
    expect(got.progress).toMatchObject({
      documentId: DOC('b'),
      segmentKey: 'v7:abc',
      segmentOrdinal: 12,
      progress: 0.25,
      clientUpdatedAtMs: 1_000,
    });
    expect(got.progress).not.toHaveProperty('readerType');
  });

  test('returns a converted row as a keyless ordinal and ignores stale writes', async () => {
    const got = await (await getProgress(request('GET', undefined, `?documentId=${DOC('a')}`))).json();
    expect(got.progress).toMatchObject({ segmentKey: null, segmentOrdinal: 3 });

    const stale = await (await putProgress(request('PUT', {
      documentId: DOC('a'), segmentKey: 'v7:x', segmentOrdinal: 0, clientUpdatedAtMs: 50,
    }))).json();
    expect(stale).toMatchObject({ applied: false, progress: { segmentKey: null, segmentOrdinal: 3 } });
  });

  test('rejects a position without a segment key', async () => {
    const response = await putProgress(request('PUT', { documentId: DOC('a'), segmentOrdinal: 1 }));
    expect(response.status).toBe(400);
    const legacy = await putProgress(request('PUT', { documentId: DOC('a'), readerType: 'pdf', location: '2:1' }));
    expect(legacy.status).toBe(400);
  });
});
