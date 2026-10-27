import { beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { pcmToWav } from '@openreader/tts/openrouter';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), resolve: vi.fn(), list: vi.fn(), read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: mocks.auth }));
vi.mock('@/lib/server/admin/resolve-credentials', () => ({ resolveTtsCredentials: mocks.resolve }));
vi.mock('@/lib/server/runtime-config', () => ({ getResolvedRuntimeConfig: async () => ({ defaultTtsProvider: 'fish' }) }));
vi.mock('@/lib/server/tts/cloned-voices', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/server/tts/cloned-voices')>(),
  listClonedVoices: mocks.list, readClonedVoice: mocks.read, writeClonedVoice: mocks.write, deleteClonedVoice: mocks.remove }));
const { POST, GET, PATCH, DELETE } = await import('@/app/api/tts/cloned-voices/route');
const sample = { name: 'My narrator', audio: Buffer.from(pcmToWav(new Uint8Array(48_000))).toString('base64'),
  permitted: true, transcript: 'A clear sample.', providerRef: 'fish', model: 's2.1-pro-free' };
function req(method: string, value?: unknown) { return new NextRequest('http://localhost/api/tts/cloned-voices', { method,
  ...(value ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}) }); }
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); mocks.auth.mockResolvedValue({ userId: 'alice' }); mocks.list.mockResolvedValue([]);
  mocks.resolve.mockResolvedValue({ provider: 'fish-audio', apiKey: 'secret', adminRecord: { slug: 'fish' } }); });
test('requires authentication for every library action', async () => {
  mocks.auth.mockResolvedValue(new Response(null, { status: 401 }));
  for (const [handler, method] of [[GET, 'GET'], [POST, 'POST'], [PATCH, 'PATCH'], [DELETE, 'DELETE']] as const) {
    expect((await handler(req(method))).status).toBe(401);
  }
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
});
test('requires permission and rejects oversized or malformed recordings before contacting providers', async () => {
  for (const change of [{ permitted: false }, { audio: 'malformed' }, { name: '' }, { transcript: 'x'.repeat(4001) }]) {
    expect((await POST(req('POST', { ...sample, ...change }))).status).toBe(400);
  }
  expect(mocks.resolve).not.toHaveBeenCalled();
});
test('saves a private Fish sample without requiring upstream model creation and returns no credentials or media', async () => {
  const fetch = vi.fn(async () => Response.json({ _id: 'private-fish-id' })); vi.stubGlobal('fetch', fetch);
  const response = await POST(req('POST', sample));
  expect(response.status).toBe(201);
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.write).toHaveBeenCalledWith('alice', expect.objectContaining({ audio: sample.audio, providerType: 'fish-audio' }));
  const body = JSON.stringify(await response.json());
  for (const hidden of [sample.audio, sample.transcript, 'secret']) expect(body).not.toContain(hidden);
  vi.unstubAllGlobals();
});
test('requires the spoken transcript for Fish Audio references', async () => {
  expect((await POST(req('POST', { ...sample, transcript: '  ' }))).status).toBe(400);
  expect(mocks.write).not.toHaveBeenCalled();
});
test('still lists saved voices when OpenRouter capability discovery fails', async () => {
  mocks.resolve.mockResolvedValue({ provider: 'openrouter', apiKey: 'secret' });
  mocks.list.mockResolvedValue([{ id: 'clone:x', name: 'Saved' }]);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  const response = await GET(new NextRequest('http://localhost/api/tts/cloned-voices?providerRef=or&model=example%2Fdiscovery-down'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ supportsCloning: false, voices: [{ name: 'Saved' }] });
});
test('uses authenticated ownership for rename and deletion regardless of a supplied user ID', async () => {
  const id = 'clone:7e94cb5c-1032-44b8-84ee-8a7a6f99d629';
  mocks.read.mockResolvedValue({ id, name: 'Old name' });
  expect((await PATCH(req('PATCH', { id, name: 'New name', userId: 'bob' }))).status).toBe(200);
  expect(mocks.read).toHaveBeenCalledWith('alice', id);
  expect((await DELETE(req('DELETE', { id, userId: 'bob' }))).status).toBe(200);
  expect(mocks.remove).toHaveBeenCalledWith('alice', id);
});
