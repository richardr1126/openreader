import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown, sqlite: null as unknown as import('better-sqlite3').Database,
  userId: 'owner' as string | null, blobs: new Map<string, Buffer>(), receipts: new Map<string, unknown>(),
  parse: vi.fn(), article: vi.fn(), conversion: vi.fn(),
}));
vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: () => undefined }));
vi.mock('@openreader/database', () => ({ get db() { return state.db; } }));
vi.mock('@/lib/server/auth/auth', () => ({ getAuthContext: async () => ({ userId: state.userId, user: { isAnonymous: false } }), getTrustedOrigins: () => ['http://localhost'] }));
vi.mock('@/lib/server/storage/s3', () => ({ isS3Configured: () => true, getBrowserStorageTransport: () => 'proxy' }));
vi.mock('@/lib/server/runtime-config', () => ({ getResolvedRuntimeConfig: async () => ({ maxUploadMb: 10, computeLimitPolicies: {} }) }));
vi.mock('@/lib/server/documents/web-loader', () => ({ fetchAndParseUrl: state.article }));
vi.mock('@/lib/server/documents/previews', () => ({ enqueueDocumentPreview: async () => undefined }));
vi.mock('@/lib/server/tts/segments-cache', () => ({ deleteDocumentTtsSegmentCache: async () => undefined }));
vi.mock('@/lib/server/documents/blob-lease', () => ({ withDocumentBlobLease: async (_id: string, run: () => Promise<unknown>) => run() }));
vi.mock('@/lib/server/compute-limits/run-admitted', async original => ({
  ...await original<typeof import('@/lib/server/compute-limits/run-admitted')>(), createAdmittedComputeOperation: async (input: { create: () => Promise<unknown> }) => input.create(),
}));
vi.mock('@/lib/server/pdf-parse/operation', () => ({ resolveCurrentPdfParse: state.parse }));
vi.mock('@/lib/server/compute-worker/client', () => ({ isComputeWorkerAvailable: () => false, isComputeWorkerUnavailableError: () => false,
  getComputeWorkerClient: () => ({ resolveDocumentConversion: state.conversion }),
}));
vi.mock('@/lib/server/documents/blobstore', () => {
  const key = (id: string, owner: string) => `temp:${owner}:${id}`;
  const missing = () => Object.assign(new Error('missing'), { code: 'NoSuchKey' });
  return {
    TEMP_DOCUMENT_UPLOAD_TTL_MS: 86400000,
    isValidDocumentId: (id: string) => /^[a-f0-9]{64}$/.test(id),
    isValidTempUploadToken: (id: string) => /^[0-9a-f-]{36}$/.test(id),
    isMissingBlobError: (error: { code?: string }) => error?.code === 'NoSuchKey',
    isDocumentBlobIntegrityError: () => false, isPreconditionFailed: () => false,
    getTempDocumentFinalizeReceipt: async (id: string, owner: string) => state.receipts.get(key(id, owner)) ?? null,
    putTempDocumentFinalizeReceipt: async (id: string, owner: string, _ns: unknown, bytes: Buffer) => { state.receipts.set(key(id, owner), JSON.parse(bytes.toString())); },
    putTempDocumentBlob: async (id: string, owner: string, bytes: Buffer) => { state.blobs.set(key(id, owner), bytes); },
    headTempDocumentBlob: async (id: string, owner: string) => {
      const bytes = state.blobs.get(key(id, owner)); if (!bytes) throw missing();
      return { contentLength: bytes.length, contentType: 'text/plain', lastModified: Date.now() };
    },
    getTempDocumentBlob: async (id: string, owner: string) => { const bytes = state.blobs.get(key(id, owner)); if (!bytes) throw missing(); return bytes; },
    headDocumentBlob: async (id: string) => { const bytes = state.blobs.get(id); if (!bytes) throw missing(); return { contentLength: bytes.length, contentType: 'text/plain' }; },
    copyTempDocumentBlobToDocument: async (id: string, owner: string, document: string) => { state.blobs.set(document, state.blobs.get(key(id, owner))!); },
    verifyDocumentBlobIntegrity: async (id: string, _ns: unknown, expected?: number) => {
      const bytes = state.blobs.get(id); if (!bytes) throw missing();
      if (createHash('sha256').update(bytes).digest('hex') !== id || (expected !== undefined && bytes.length !== expected)) throw new Error('integrity mismatch');
      return bytes.length;
    },
    deleteTempDocumentUpload: async (id: string, owner: string) => { state.blobs.delete(key(id, owner)); },
  };
});

import { GET as list, POST as create, PATCH as move } from '@/app/api/v1/documents/route';
import { GET as read, PATCH as update } from '@/app/api/v1/documents/[id]/route';
import { POST as prepare } from '@/app/api/v1/uploads/route';
import { GET as uploadStatus } from '@/app/api/v1/uploads/[uploadId]/route';
import { PUT as transfer } from '@/app/api/v1/uploads/[uploadId]/file/route';

function request(path: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost${path}`, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const uploadParams = (uploadId: string) => ({ params: Promise.resolve({ uploadId }) });
function insert(id: string, owner = 'owner', name = 'notes.txt', type = 'html') {
  state.sqlite.prepare('insert into documents (id,user_id,name,type,size,last_modified,file_path) values (?,?,?,?,?,?,?)').run(id, owner, name, type, 1, 1, id);
}

beforeEach(() => {
  vi.stubEnv('BASE_URL', 'http://localhost:3003');
  state.userId = 'owner'; state.blobs.clear(); state.receipts.clear();
  state.article.mockReset().mockResolvedValue({ title: 'An article', content: '# Imported article', author: 'Article Author', language: 'de' });
  state.parse.mockReset().mockResolvedValue({ artifact: { objectKey: 'parsed' }, operation: null });
  state.sqlite = new Database(':memory:');
  state.sqlite.exec(`
    create table documents (id text, user_id text, name text, type text, size integer, last_modified integer, file_path text, folder_id text,
      recently_opened_at integer, author text, language text, created_at integer, primary key(id,user_id));
    create table user_document_progress (user_id text, document_id text, progress real, updated_at integer);
    create table user_folders (id text, user_id text, name text, position integer, created_at integer, updated_at integer);
  `);
  state.db = drizzle(state.sqlite);
});
afterEach(() => { state.sqlite.close(); vi.unstubAllEnvs(); });

test('lists only owned documents with stable cursors, literal search and folder filtering', async () => {
  insert('a'.repeat(64), 'owner', '100% notes.txt'); insert('b'.repeat(64)); insert('c'.repeat(64), 'other');
  const first = await (await list(request('/api/v1/documents?limit=1'))).json();
  expect(first.data).toHaveLength(1); expect(first.nextCursor).toBe('a'.repeat(64));
  const next = await (await list(request(`/api/v1/documents?limit=1&cursor=${first.nextCursor}`))).json();
  expect(next.data[0].id).toBe('b'.repeat(64)); expect(next.nextCursor).toBeNull();
  const search = await (await list(request('/api/v1/documents?q=%25'))).json();
  expect(search.data.map((doc: { name: string }) => doc.name)).toEqual(['100% notes.txt']);
  expect((await (await list(request('/api/v1/documents?folderId=missing'))).json()).data).toEqual([]);
});

test('creates text and URL documents directly on the server with canonical identities and metadata', async () => {
  const text = 'A new document created directly through the public API.';
  const response = await create(request('/api/v1/documents', 'POST', { source: { type: 'text', text }, name: 'new.txt' }));
  expect(response.status).toBe(201);
  const document = await response.json();
  expect(document.id).toBe(createHash('sha256').update(text).digest('hex'));
  expect(document.status).toBe('ready'); expect(document.fileUrl).toContain(document.id);
  const imported = await (await create(request('/api/v1/documents', 'POST', { source: { type: 'url', url: 'https://example.test/article' } }))).json();
  expect(imported).toMatchObject({ name: 'An_article.md', author: 'Article Author', language: 'de' });
  expect(state.article).toHaveBeenCalledWith('https://example.test/article');
});

test('prepared upload ownership, bounded transfer and repeated status lead to one verified document', async () => {
  const prepared = await (await prepare(request('/api/v1/uploads', 'POST', { name: 'upload.txt', size: 5, contentType: 'text/plain' }))).json();
  state.userId = 'other';
  expect((await uploadStatus(request(`/api/v1/uploads/${prepared.id}`), uploadParams(prepared.id))).status).toBe(404);
  state.userId = 'owner';
  const sent = await transfer(new NextRequest(`http://localhost${prepared.url}`, { method: 'PUT', body: 'hello' }), uploadParams(prepared.id));
  expect(sent.status).toBe(204);
  const created = await create(request('/api/v1/documents', 'POST', { source: { type: 'upload', uploadId: prepared.id } }));
  expect(created.status).toBe(201);
  const document = await created.json();
  const status = await (await uploadStatus(request(`/api/v1/uploads/${prepared.id}`), uploadParams(prepared.id))).json();
  expect(status).toMatchObject({ status: 'ready', document: { id: document.id } });
  expect(state.sqlite.prepare('select count(*) as count from documents').get()).toEqual({ count: 1 });
  state.blobs.set(document.id, Buffer.from('corrupt'));
  expect((await uploadStatus(request(`/api/v1/uploads/${prepared.id}`), uploadParams(prepared.id))).status).toBe(503);
});

test('document reads and mutations enforce ownership and do not change reader recency', async () => {
  const id = 'a'.repeat(64); insert(id); insert('b'.repeat(64), 'other');
  expect((await read(request(`/api/v1/documents/${'b'.repeat(64)}`), params('b'.repeat(64)))).status).toBe(404);
  expect((await read(request(`/api/v1/documents/${id}`), params(id))).status).toBe(200);
  expect(state.sqlite.prepare('select recently_opened_at from documents where id=?').get(id)).toEqual({ recently_opened_at: null });
  const changed = await update(request(`/api/v1/documents/${id}`, 'PATCH', { name: 'renamed.txt' }), params(id));
  expect((await changed.json()).name).toBe('renamed.txt');
  state.sqlite.prepare('insert into user_folders (id,user_id) values (?,?)').run('folder', 'owner');
  expect((await move(request('/api/v1/documents', 'PATCH', { ids: [id], folderId: 'folder' }))).status).toBe(200);
  expect((await move(request('/api/v1/documents', 'PATCH', { ids: [id, 'b'.repeat(64)], folderId: null }))).status).toBe(404);
});

test('PDF status reads reflect worker operations without creating reading plans', async () => {
  const id = 'a'.repeat(64); insert(id, 'owner', 'book.pdf', 'pdf');
  state.parse.mockResolvedValue({ artifact: null, operation: { opId: 'parse', status: 'running' } });
  expect(await (await read(request(`/api/v1/documents/${id}`), params(id))).json()).toMatchObject({ status: 'processing', operationId: 'parse' });
  state.parse.mockResolvedValue({ artifact: null, operation: { opId: 'parse', status: 'failed', error: { message: 'parse failed' } } });
  expect(await (await read(request(`/api/v1/documents/${id}`), params(id))).json()).toMatchObject({ status: 'failed', error: 'parse failed' });
});

test('unauthenticated requests and malformed pagination return public errors', async () => {
  state.userId = null;
  expect((await list(request('/api/v1/documents'))).status).toBe(401);
  state.userId = 'owner';
  const invalid = await list(request('/api/v1/documents?limit=0'));
  expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
});

test('rejects oversized JSON and malformed control bodies before creating a document', async () => {
  const oversized = await create(request('/api/v1/documents', 'POST', {
    source: { type: 'text', text: 'x'.repeat(3 * 1024 * 1024) },
  }));
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ error: { code: 'REQUEST_TOO_LARGE' } });
  const malformed = await create(new NextRequest('http://localhost/api/v1/documents', { method: 'POST', body: '{' }));
  expect(malformed.status).toBe(400);
  expect(state.sqlite.prepare('select count(*) as count from documents').get()).toEqual({ count: 0 });
});
