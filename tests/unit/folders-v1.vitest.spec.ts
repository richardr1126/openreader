import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as unknown, sqlite: null as unknown as import('better-sqlite3').Database, userId: 'alice' as string | null }));
vi.mock('@openreader/database', () => ({ get db() { return state.db; } }));
vi.mock('@openreader/database/run-in-transaction', () => ({ runInDbTransaction: async (run: (tx: unknown) => Promise<unknown>) => {
  state.sqlite.exec('BEGIN');
  try { const result = await run(state.db); state.sqlite.exec('COMMIT'); return result; }
  catch (error) { state.sqlite.exec('ROLLBACK'); throw error; }
} }));
vi.mock('@/lib/server/auth/auth', () => ({ getAuthContext: async () => ({ userId: state.userId, user: { isAnonymous: false } }), getTrustedOrigins: () => ['http://localhost'] }));

import { GET, POST, DELETE as clear } from '@/app/api/v1/folders/route';
import { PATCH, DELETE } from '@/app/api/v1/folders/[id]/route';
import { requireFolder } from '@/lib/server/folders';
const request = (path: string, method = 'GET', value?: unknown) => new NextRequest(`http://localhost/api/v1/${path}`, { method,
  ...(value === undefined ? {} : { body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } }) });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const a = 'a'.repeat(64), b = 'b'.repeat(64);
beforeEach(() => {
  state.userId = 'alice'; state.sqlite = new Database(':memory:'); state.db = drizzle(state.sqlite);
  state.sqlite.exec(`create table user_folders (id text, user_id text, name text, position integer, created_at integer, updated_at integer, primary key(id,user_id));
    create table documents (id text, user_id text, folder_id text, last_modified integer, recently_opened_at integer, primary key(id,user_id));`);
  state.sqlite.prepare('insert into documents values (?,?,?,10,20)').run(a, 'alice', null);
  state.sqlite.prepare('insert into documents values (?,?,?,10,20)').run(b, 'bob', null);
});
afterEach(() => state.sqlite.close());

test('creates and renames a folder without exposing its owner or altering document versions', async () => {
  const created = await POST(request('folders', 'POST', { id: 'notes', name: ' Notes ', documentIds: [a] }));
  expect(created.status).toBe(201); expect(created.headers.get('Location')).toBe('/api/v1/folders/notes');
  expect(await created.json()).toMatchObject({ id: 'notes', name: 'Notes' });
  expect(state.sqlite.prepare('select folder_id,last_modified,recently_opened_at from documents where id=?').get(a))
    .toEqual({ folder_id: 'notes', last_modified: 10, recently_opened_at: 20 });
  const updated = await PATCH(request('folders/notes', 'PATCH', { name: 'Renamed', position: 2 }), context('notes'));
  expect(await updated.json()).toMatchObject({ name: 'Renamed', position: 2 });
  const page = await (await GET(request('folders'))).json();
  expect(page.data).toHaveLength(1); expect(page.data[0]).not.toHaveProperty('userId'); expect(page.nextCursor).toBeNull();
});

test('rejects foreign documents atomically and isolates same-named folder IDs across users', async () => {
  const denied = await POST(request('folders', 'POST', { id: 'notes', name: 'Notes', documentIds: [a, b] }));
  expect(denied.status).toBe(404);
  expect(state.sqlite.prepare('select count(*) as n from user_folders').get()).toEqual({ n: 0 });
  await POST(request('folders', 'POST', { id: 'notes', name: 'Alice' }));
  expect((await POST(request('folders', 'POST', { id: 'notes', name: 'Duplicate' }))).status).toBe(409);
  state.userId = 'bob';
  expect((await PATCH(request('folders/notes', 'PATCH', { name: 'Wrong' }), context('notes'))).status).toBe(404);
  expect((await POST(request('folders', 'POST', { id: 'notes', name: 'Bob' }))).status).toBe(201);
  expect((await (await GET(request('folders'))).json()).data.map((row: { name: string }) => row.name)).toEqual(['Bob']);
});

test('paginates in display order with tied positions and legacy null timestamps', async () => {
  const insert = state.sqlite.prepare('insert into user_folders values (?,?,?,?,?,?)');
  insert.run('z', 'alice', 'First', 0, null, null); insert.run('a', 'alice', 'Second', 1, 2, 2);
  insert.run('b', 'alice', 'Third', 1, 2, 2); insert.run('hidden', 'bob', 'Hidden', -1, 1, 1);
  const first = await (await GET(request('folders?limit=1'))).json();
  expect(first.data[0]).toMatchObject({ id: 'z', createdAt: 0, updatedAt: 0 });
  const second = await (await GET(request(`folders?limit=1&cursor=${first.nextCursor}`))).json();
  expect(second.data[0].id).toBe('a');
  const third = await (await GET(request(`folders?limit=1&cursor=${second.nextCursor}`))).json();
  expect(third.data[0].id).toBe('b'); expect(third.nextCursor).toBeNull();
  expect((await GET(request('folders?cursor=invalid'))).status).toBe(400);
});

test('folder deletion unfiles only the caller documents and leaves every document stored', async () => {
  await POST(request('folders', 'POST', { id: 'notes', name: 'Notes', documentIds: [a] }));
  state.userId = 'bob'; await POST(request('folders', 'POST', { id: 'notes', name: 'Notes', documentIds: [b] }));
  state.userId = 'alice';
  expect((await DELETE(request('folders/notes', 'DELETE'), context('notes'))).status).toBe(204);
  expect(state.sqlite.prepare('select folder_id from documents where id=?').get(a)).toEqual({ folder_id: null });
  expect(state.sqlite.prepare('select folder_id from documents where id=?').get(b)).toEqual({ folder_id: 'notes' });
  await POST(request('folders', 'POST', { name: 'Another', documentIds: [a] }));
  expect((await clear(request('folders', 'DELETE'))).status).toBe(204);
  expect(state.sqlite.prepare('select count(*) as n from documents').get()).toEqual({ n: 2 });
  expect(state.sqlite.prepare('select count(*) as n from user_folders').get()).toEqual({ n: 1 });
});

test('requires authentication and rejects cross-site writes, oversized bodies and invalid fields', async () => {
  state.userId = null; expect((await GET(request('folders'))).status).toBe(401); state.userId = 'alice';
  expect((await POST(new NextRequest('http://localhost/api/v1/folders', { method: 'POST', headers: { Origin: 'https://foreign.test' }, body: '{}' }))).status).toBe(403);
  expect((await POST(request('folders', 'POST', { name: 'x'.repeat(65536) }))).status).toBe(413);
  expect((await POST(request('folders', 'POST', { name: 'Notes', documentIds: [b, 1] }))).status).toBe(400);
  expect((await PATCH(request('folders/notes', 'PATCH', { position: '1' }), context('notes'))).status).toBe(400);
});

test('a folder is found by ID for its owner alone', async () => {
  await POST(request('folders', 'POST', { id: 'notes', name: 'Notes' }));
  expect(await requireFolder({ userId: 'alice', isAnonymous: false, scopes: [] }, 'notes')).toMatchObject({ id: 'notes', name: 'Notes' });
  await expect(requireFolder({ userId: 'bob', isAnonymous: false, scopes: [] }, 'notes')).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
});
