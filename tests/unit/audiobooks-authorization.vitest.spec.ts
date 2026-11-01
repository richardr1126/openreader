import { beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), operation: vi.fn(), artifact: vi.fn(), proxy: vi.fn(), send: vi.fn(),
  admissions: [] as Array<{ id: string }>,
}));
vi.mock('@/lib/server/auth/auth', () => ({ getAuthContext: mocks.auth, getTrustedOrigins: () => ['http://localhost'] }));
vi.mock('@/lib/server/tts/segments-auth', () => ({ resolveUserDocumentScope: mocks.scope }));
vi.mock('@openreader/database', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.admissions }) }) }),
} }));
vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: () => true,
  isComputeWorkerUnavailableError: () => false,
  getComputeWorkerClient: () => ({ getOperation: mocks.operation }),
  ComputeWorkerClient: class { getTtsPlaybackExportArtifact = mocks.artifact; },
}));
vi.mock('@/lib/server/compute-worker/operation-events-proxy', () => ({ proxyOperationEvents: mocks.proxy }));
vi.mock('@/lib/server/storage/artifact-download', () => ({ sendStorageArtifact: mocks.send }));
vi.mock('@/lib/server/storage/s3', () => ({ isS3Configured: () => true }));
vi.mock('@/lib/server/reader/bootstrap', () => ({}));
vi.mock('@/lib/server/reader/playback', () => ({}));
vi.mock('@/lib/server/tts/playback-plans', () => ({}));

import { GET as events } from '@/app/api/v1/documents/[id]/audiobooks/events/route';
import { GET as file } from '@/app/api/v1/documents/[id]/audiobooks/files/[artifactId]/route';
import { resolveApiPrincipal } from '@/lib/server/api/principal';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: 'owner', user: { isAnonymous: false } });
  mocks.scope.mockResolvedValue({ userId: 'owner', storageUserId: 'owner', documentVersion: 1, readerType: 'html' });
  mocks.operation.mockResolvedValue({ subject: { kind: 'tts_playback', documentId: 'shared-content' } });
  mocks.artifact.mockResolvedValue({ storageUserId: 'owner', objectKey: 'owned-file', contentType: 'audio/mpeg', dispositionFilename: 'book.mp3' });
  mocks.proxy.mockResolvedValue(new Response('event: snapshot\n\n'));
  mocks.send.mockResolvedValue(new Response('audio'));
  mocks.admissions = [{ id: 'owned-admission' }];
});

const eventRequest = () => new NextRequest('http://localhost/api/v1/documents/shared-content/audiobooks/events?opId=operation');
const eventContext = { params: Promise.resolve({ id: 'shared-content' }) };
const fileRequest = () => new NextRequest('http://localhost/api/v1/documents/shared-content/audiobooks/files/abcdef1234567890');
const fileContext = { params: Promise.resolve({ id: 'shared-content', artifactId: 'abcdef1234567890' }) };

test('events and file routes reject an unauthenticated caller before reading worker state', async () => {
  mocks.auth.mockResolvedValue({ userId: null });
  expect((await events(eventRequest(), eventContext)).status).toBe(401);
  expect((await file(fileRequest(), fileContext)).status).toBe(401);
  expect(mocks.operation).not.toHaveBeenCalled();
  expect(mocks.artifact).not.toHaveBeenCalled();
});

test('events and file routes require document ownership', async () => {
  mocks.scope.mockResolvedValue(null);
  expect((await events(eventRequest(), eventContext)).status).toBe(404);
  expect((await file(fileRequest(), fileContext)).status).toBe(404);
  expect(mocks.operation).not.toHaveBeenCalled();
  expect(mocks.artifact).not.toHaveBeenCalled();
});

test('owning identical document content does not grant access to another users operation', async () => {
  mocks.admissions = [];
  expect((await events(eventRequest(), eventContext)).status).toBe(403);
  expect(mocks.proxy).not.toHaveBeenCalled();
});

test('file lookup is scoped to the owner and rejects mismatched metadata', async () => {
  mocks.artifact.mockResolvedValue({ storageUserId: 'other-user' });
  expect((await file(fileRequest(), fileContext)).status).toBe(404);
  expect(mocks.artifact).toHaveBeenCalledWith({ artifactId: 'abcdef1234567890', storageUserId: 'owner', documentId: 'shared-content' });
  expect(mocks.send).not.toHaveBeenCalled();
});

test('owned operations and files can be read', async () => {
  expect((await events(eventRequest(), eventContext)).status).toBe(200);
  expect((await file(fileRequest(), fileContext)).status).toBe(200);
});

test('cookie-authenticated writes reject a foreign origin, including browsers without Fetch Metadata', async () => {
  for (const headers of [new Headers({ origin: 'https://foreign.invalid' }), new Headers({ 'sec-fetch-site': 'cross-site' })]) {
    const principal = await resolveApiPrincipal(new NextRequest('http://localhost/api/v1/documents/doc/audiobooks', {
      method: 'POST', headers,
    }), 'audio:generate');
    expect(principal).toBeInstanceOf(Response);
    expect((principal as Response).status).toBe(403);
  }
});
