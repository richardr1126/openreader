import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, afterAll, expect, test, vi } from 'vitest';
import { runMigrations } from '@openreader/database/migrate';

const mocks = vi.hoisted(() => ({ fetchUrl: vi.fn(), receipt: vi.fn(), presign: vi.fn() }));
vi.mock('@/lib/server/documents/web-loader', () => ({ fetchAndParseUrl: mocks.fetchUrl }));
vi.mock('@/lib/server/storage/s3', () => ({ getBrowserStorageTransport: () => 'presigned', isS3Configured: () => true }));
vi.mock('@/lib/server/documents/blobstore', () => ({ putTempDocumentFinalizeReceipt: mocks.receipt, presignTempPut: mocks.presign }));

const directory = mkdtempSync(join(tmpdir(), 'openreader-storage-ledger-'));
const databasePath = join(directory, 'sqlite.db');
const original = { ...process.env };
const doc = 'a'.repeat(64), orphan = 'b'.repeat(64);
let ledger: typeof import('@/lib/server/storage/usage');
let settings: typeof import('@/lib/server/admin/settings');
function sql(query: string, ...args: unknown[]) {
  const database = new Database(databasePath);
  try { return database.prepare(query).all(...args) as Record<string, unknown>[]; } finally { database.close(); }
}
function execute(query: string) {
  const database = new Database(databasePath);
  try { database.exec(query); } finally { database.close(); }
}
const account = { userId: 'account', isAnonymous: false };
const guest = { userId: 'guest', isAnonymous: true };
function caller(subject = account) { return { principal: { ...subject, scopes: ['documents:read', 'documents:write', 'audio:generate'] }, subject, schedule: () => undefined } as import('@/lib/server/documents/request').DocumentCaller; }
async function audio(userId: string, documentId: string, audioBytes: number) {
  const revision = await ledger.beginAudioMeasurement(userId, documentId);
  expect(revision).not.toBeNull();
  await ledger.reportAudioMeasurement({ userId, documentId, revision: revision!, audioBytes });
}
beforeAll(async () => {
  process.env.SQLITE_DB_PATH = databasePath; delete process.env.POSTGRES_URL; delete process.env.DESKTOP_LAUNCH_TOKEN;
  process.env.BASE_URL = 'http://localhost:3003'; process.env.AUTH_SECRET = 'storage-test-secret-at-least-32-characters';
  process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN = 'storage-test-broker';
  await runMigrations({ cwd: directory, env: { ...process.env, POSTGRES_URL: '', SQLITE_DB_PATH: databasePath } });
  vi.resetModules();
  ledger = await import('@/lib/server/storage/usage'); settings = await import('@/lib/server/admin/settings');
});
beforeEach(() => {
  execute(`delete from document_audio_usage; delete from documents; delete from compute_limit_events; delete from compute_limit_admissions; delete from compute_limit_buckets; delete from admin_settings; delete from user;
    insert into user(id,name,email,email_verified,is_anonymous,is_admin,admin_source,access_status,created_at,updated_at) values
    ('account','Account','account@example.test',1,0,0,'none','active',1,1), ('guest','Guest','guest@example.test',0,1,0,'none','active',1,1), ('other-guest','Other','other@example.test',0,1,0,'none','active',1,1);`);
  settings.invalidateRuntimeConfigCache();
  vi.clearAllMocks();
  mocks.presign.mockResolvedValue({ url: 'https://storage.example/upload', headers: {} });
});
afterAll(() => {
  for (const key of ['SQLITE_DB_PATH', 'POSTGRES_URL', 'DESKTOP_LAUNCH_TOKEN', 'BASE_URL', 'AUTH_SECRET', 'COMPUTE_CREDENTIAL_BROKER_TOKEN']) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  rmSync(directory, { recursive: true, force: true });
});

test('one SQL total includes source files and owned/orphaned audio, excludes other users, and matches admin data', async () => {
  execute(`insert into documents(id,user_id,name,type,size,last_modified,file_path) values ('${doc}','account','book.txt','html',20,1,'${doc}');`);
  await audio('account', doc, 50); await audio('account', orphan, 30); await audio('guest', doc, 200);
  const total = (await ledger.getStorageUsage(['account'])).get('account');
  expect(total).toEqual({ documentBytes: 20, audioBytes: 80, totalBytes: 100, documentCount: 1, orphanedAudioBytes: 30, orphanedDocumentCount: 1 });
  const { listAdminUsers } = await import('@/lib/server/admin/users');
  expect((await listAdminUsers({ search: 'account@example.test' })).users[0]).toMatchObject({ documentBytes: 20, audioBytes: 80, storageBytes: 100 });
});

test('clear leases reject pre-clear/out-of-order reports and deleted users cannot be recreated', async () => {
  const before = (await ledger.beginAudioMeasurement('account', doc))!;
  await ledger.reportAudioMeasurement({ userId: 'account', documentId: doc, revision: before, audioBytes: 100 });
  const clearing = (await ledger.beginAudioMeasurement('account', doc, true))!;
  expect(await ledger.beginAudioMeasurement('account', doc)).toBeNull();
  await ledger.reportAudioMeasurement({ userId: 'account', documentId: doc, revision: clearing, audioBytes: 0 });
  await ledger.reportAudioMeasurement({ userId: 'account', documentId: doc, revision: before, audioBytes: 100 });
  expect((await ledger.getStorageUsage(['account'])).get('account')?.audioBytes).toBe(0);
  execute("delete from user where id='account'");
  await ledger.reportAudioMeasurement({ userId: 'account', documentId: doc, revision: clearing, audioBytes: 100 });
  expect(await ledger.beginAudioMeasurement('account', doc)).toBeNull();
  expect(sql('select * from document_audio_usage')).toHaveLength(0);
});

test('storage caps stop upload preparation before receipts/URLs, and the guest pool does not affect accounts', async () => {
  await settings.setRuntimeConfigKey('limitGuestStoragePool', true);
  await settings.setRuntimeConfigKey('guestStoragePoolMb', 1);
  await audio('other-guest', doc, 1_048_576);
  const { prepareDocumentUpload } = await import('@/lib/server/documents/uploads');
  await expect(prepareDocumentUpload(caller(guest), { name: 'book.txt', size: 1 })).rejects.toMatchObject({ code: 'GUEST_STORAGE_POOL_FULL' });
  expect(mocks.receipt).not.toHaveBeenCalled(); expect(mocks.presign).not.toHaveBeenCalled();
  await expect(prepareDocumentUpload(caller(), { name: 'book.txt', size: 1 })).resolves.toMatchObject({ url: 'https://storage.example/upload' });
  await settings.setRuntimeConfigKey('limitAccountStorage', true); await settings.setRuntimeConfigKey('accountStorageMb', 1);
  await audio('account', doc, 1_048_575);
  await expect(prepareDocumentUpload(caller(), { name: 'book.txt', size: 2 })).rejects.toMatchObject({ code: 'ACCOUNT_STORAGE_LIMIT_REACHED' });
});

test('concurrent final registrations cannot bypass the per-account or shared guest cap', async () => {
  await settings.setRuntimeConfigKey('limitAccountStorage', true); await settings.setRuntimeConfigKey('accountStorageMb', 1);
  const { documents } = await import('@openreader/database/schema');
  const register = (userId: string, id: string) => ledger.withStorageRegistration({ userId, documentId: id, size: 700_000 }, async (conn) => {
    await conn.insert(documents).values({ id, userId, name: 'book.txt', type: 'html', size: 700_000, lastModified: 1, filePath: id });
  });
  const accounts = await Promise.allSettled([register('account', doc), register('account', orphan)]);
  expect(accounts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  await settings.setRuntimeConfigKey('limitGuestStoragePool', true); await settings.setRuntimeConfigKey('guestStoragePoolMb', 1);
  const guests = await Promise.allSettled([register('guest', doc), register('other-guest', orphan)]);
  expect(guests.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
});

test('daily file limits are strict, audience-specific and stop URL imports before fetching', async () => {
  const policy = (await settings.getRuntimeConfig()).computeLimitPolicies;
  policy.actions.document_intake.enabled = true;
  policy.actions.document_intake.usage[0].limit = 1; policy.actions.document_intake.usage[1].limit = 2;
  await settings.setRuntimeConfigKey('computeLimitPolicies', policy);
  const { consumeDocumentIntake } = await import('@/lib/server/documents/intake');
  await consumeDocumentIntake(guest, 'same'); await consumeDocumentIntake(guest, 'same');
  const { createDocument } = await import('@/lib/server/documents/create');
  await expect(createDocument(caller(guest), { source: { type: 'url', url: 'https://example.com' } })).rejects.toMatchObject({ code: 'DOCUMENT_INTAKE_LIMIT_REACHED' });
  expect(mocks.fetchUrl).not.toHaveBeenCalled();
  await consumeDocumentIntake(account, 'first'); await consumeDocumentIntake(account, 'second');
  await expect(consumeDocumentIntake(account, 'third')).rejects.toMatchObject({ code: 'DOCUMENT_INTAKE_LIMIT_REACHED' });
});

test('uncached audio is storage-limited even with daily characters off, then resumes after clearing', async () => {
  await settings.setRuntimeConfigKey('limitAccountStorage', true); await settings.setRuntimeConfigKey('accountStorageMb', 1);
  expect((await settings.getRuntimeConfig()).computeLimitPolicies.actions.tts_synthesis.enabled).toBe(false);
  await audio('account', doc, 1_048_576);
  const { reserveComputeAdmission } = await import('@/lib/server/compute-limits/admission');
  const policy = (await settings.getRuntimeConfig()).computeLimitPolicies;
  await reserveComputeAdmission({ policy, action: 'tts_playback', requestKey: `tts-session:session:${Date.now()}`, subject: account });
  const { POST } = await import('@/app/api/internal/compute/limits/consume/route');
  const request = () => new NextRequest('http://localhost/api/internal/compute/limits/consume', { method: 'POST', headers: { Authorization: 'Bearer storage-test-broker' }, body: JSON.stringify({ action: 'tts_synthesis', userId: 'account', sessionId: 'session', eventKey: 'segment', characters: 20 }) });
  expect(await (await POST(request())).json()).toMatchObject({ allowed: false, charged: false, storageLimit: 'ACCOUNT_STORAGE_LIMIT_REACHED' });
  expect(sql('select * from compute_limit_events')).toHaveLength(0);
  const revision = (await ledger.beginAudioMeasurement('account', doc, true))!;
  await ledger.reportAudioMeasurement({ userId: 'account', documentId: doc, revision, audioBytes: 0 });
  expect(await (await POST(request())).json()).toMatchObject({ allowed: true, charged: false });
});

test('storage reporting requires the broker token and validates the scope and size', async () => {
  const { POST } = await import('@/app/api/internal/compute/storage/route');
  const request = (body: unknown, token = 'storage-test-broker') => new NextRequest('http://localhost/api/internal/compute/storage', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  expect((await POST(request({ action: 'begin', userId: 'account', documentId: doc }, 'wrong'))).status).toBe(401);
  expect((await POST(request({ action: 'begin', userId: 'account', documentId: '../other' }))).status).toBe(400);
  const response = await POST(request({ action: 'begin', userId: 'account', documentId: doc }));
  const { revision } = await response.json(); expect(revision).toBeGreaterThan(0);
  expect((await POST(request({ action: 'report', userId: 'account', documentId: doc, revision, audioBytes: -1 }))).status).toBe(400);
  expect((await POST(request({ action: 'report', userId: 'account', documentId: doc, revision, audioBytes: 50 }))).status).toBe(200);
  expect((await ledger.getStorageUsage(['account'])).get('account')?.audioBytes).toBe(50);
});

test('repair includes recent API audio activity without a browser session and retains orphaned scopes', async () => {
  await audio('account', orphan, 50);
  const { executeMaintenanceStep } = await import('@/lib/server/tasks/maintenance-control');
  expect(await executeMaintenanceStep({ action: 'storage-users', activeSince: Date.now() - 60_000 })).toEqual({ userIds: ['account'] });
  expect(await executeMaintenanceStep({ action: 'storage-documents', userId: 'account' })).toEqual({ documentIds: [orphan] });
  execute("update user set deletion_requested_at=1 where id='account'");
  expect(await executeMaintenanceStep({ action: 'storage-users', activeSince: 0 })).toEqual({ userIds: ['guest', 'other-guest'] });
});
