import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const state = vi.hoisted(() => ({ userId: 'alice' as string | null, credentials: vi.fn(), voices: vi.fn(), clones: vi.fn(),
  db: null as unknown, sqlite: null as unknown as import('better-sqlite3').Database }));
vi.mock('@openreader/database', () => ({ get db() { return state.db; } }));
vi.mock('@/lib/server/admin/providers', () => ({ listAdminProviders: async () => [
  { slug: 'speech', providerType: 'openai', defaultModel: 'tts-1', enabled: true },
  { slug: 'personal', providerType: 'openai', defaultModel: 'tts-1', enabled: true },
] }));
vi.mock('@/lib/server/auth/auth', () => ({ getAuthContext: async () => ({ userId: state.userId, user: { isAnonymous: false } }), getTrustedOrigins: () => [] }));
vi.mock('@/lib/server/runtime-config', () => ({ getResolvedRuntimeConfig: async () => ({ defaultTtsProvider: 'speech', showAllProviderModels: true }) }));
vi.mock('@/lib/server/admin/resolve-credentials', () => ({ resolveTtsCredentials: state.credentials }));
vi.mock('@openreader/tts/voice-resolution', () => ({ resolveVoices: state.voices }));
vi.mock('@/lib/server/tts/cloned-voices', () => ({ listClonedVoices: state.clones }));
import { GET } from '@/app/api/v1/voices/route';
import { GET as listProviders } from '@/app/api/v1/providers/route';
import { getVoices } from '@/lib/client/api/tts';

beforeEach(() => {
  state.userId = 'alice';
  state.sqlite = new Database(':memory:'); state.db = drizzle(state.sqlite);
  state.sqlite.exec('create table user_preferences (user_id text primary key, data_json text)');
  state.credentials.mockReset().mockResolvedValue({ provider: 'openai', apiKey: 'test-provider-key', baseUrl: 'https://provider.test/v1',
    adminRecord: { slug: 'speech', providerType: 'openai', defaultModel: 'tts-1' } });
  state.voices.mockReset().mockResolvedValue({ voices: ['alloy', 'echo', 'alloy'], status: 'listed' });
  state.clones.mockReset().mockResolvedValue([]);
  vi.unstubAllGlobals();
});
afterEach(() => { state.sqlite.close(); vi.unstubAllGlobals(); });
test('uses the provider/model policy and returns stable native IDs without execution credentials', async () => {
  const response = await GET(new NextRequest('http://localhost/api/v1/voices?provider=speech&model=tts-1'));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
  const resource = await response.json();
  expect(resource).toEqual({ provider: 'speech', model: 'tts-1', status: 'listed', nextCursor: null, data: [{ id: 'alloy', name: 'alloy' }, { id: 'echo', name: 'echo' }] });
  expect(state.voices).toHaveBeenCalledWith({ provider: 'openai', model: 'tts-1', apiKey: 'test-provider-key', baseUrl: 'https://provider.test/v1' });
  expect(JSON.stringify(resource)).not.toMatch(/test-provider-key|provider\.test/);
});
test('catalogue voices carry their display names, and IDs stay the identity', async () => {
  state.credentials.mockResolvedValue({ provider: 'fish-audio', apiKey: 'test-provider-key', baseUrl: undefined,
    adminRecord: { slug: 'fish', providerType: 'fish-audio', defaultModel: 's2.1-pro-free' } });
  state.voices.mockResolvedValue({ voices: ['933563129e564b19a115bedd57b7406a', 'default'], status: 'listed' });
  const resource = await (await GET(new NextRequest('http://localhost/api/v1/voices?provider=fish'))).json();
  expect(resource.data).toEqual([{ id: '933563129e564b19a115bedd57b7406a', name: 'Sarah' }, { id: 'default', name: 'default' }]);
});
test('a provider that can speak clones lists the caller\'s for that model, and survives a storage failure', async () => {
  state.credentials.mockResolvedValue({ provider: 'fish-audio', apiKey: 'test-provider-key', baseUrl: undefined,
    adminRecord: { slug: 'fish', providerType: 'fish-audio', defaultModel: 's2.1-pro-free' } });
  state.voices.mockResolvedValue({ voices: ['default'], status: 'listed' });
  state.clones.mockResolvedValue([
    { id: 'clone:mine', name: 'My voice', providerRef: 'fish', providerType: 'fish-audio', model: 's2.1-pro-free' },
    { id: 'clone:model', name: 'Other model', providerRef: 'fish', providerType: 'fish-audio', model: 's2-pro' },
    { id: 'clone:provider', name: 'Other provider', providerRef: 'router', providerType: 'openrouter', model: 's2.1-pro-free' },
  ]);
  const read = async () => (await (await GET(new NextRequest('http://localhost/api/v1/voices?provider=fish'))).json()).data;
  expect(await read()).toEqual([{ id: 'default', name: 'default' }, { id: 'clone:mine', name: 'My voice' }]);
  expect(state.clones).toHaveBeenCalledWith('alice');
  state.clones.mockRejectedValue(new Error('storage down'));
  expect(await read()).toEqual([{ id: 'default', name: 'default' }]);
});
test('a provider that cannot speak clones never looks them up', async () => {
  await GET(new NextRequest('http://localhost/api/v1/voices?provider=speech&model=tts-1'));
  expect(state.clones).not.toHaveBeenCalled();
});
test('lists enabled providers without credentials and requires authentication', async () => {
  const response = await listProviders(new NextRequest('http://localhost/api/v1/providers'));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
  const resource = await response.json();
  expect(resource.nextCursor).toBeNull();
  expect(resource.data.map((provider: { id: string }) => provider.id)).toEqual(['speech', 'personal']);
  expect(resource.data[0]).toMatchObject({ type: 'openai', defaultModel: 'tts-1', selected: true, acceptsCustomModel: expect.any(Boolean) });
  expect(JSON.stringify(resource)).not.toMatch(/test-provider-key|provider\.test|ciphertext/i);
  state.userId = null;
  expect((await listProviders(new NextRequest('http://localhost/api/v1/providers'))).status).toBe(401);
});
test('authenticates before provider access and uses public errors for missing providers', async () => {
  state.userId = null;
  expect((await GET(new NextRequest('http://localhost/api/v1/voices'))).status).toBe(401);
  expect(state.credentials).not.toHaveBeenCalled();
  state.userId = 'alice'; state.credentials.mockResolvedValue({ error: 'no_shared_provider_configured', slug: 'speech' });
  const missing = await GET(new NextRequest('http://localhost/api/v1/voices'));
  expect(missing.status).toBe(503); expect(await missing.json()).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } });
});
test('client uses query selection and projects IDs into the existing voice picker contract', async () => {
  const fetch = vi.fn(async () => Response.json({ provider: 'speech', model: 'tts-1', nextCursor: null, data: [{ id: 'alloy', name: 'Alloy' }] }));
  vi.stubGlobal('fetch', fetch);
  expect(await getVoices({ provider: 'speech', model: 'tts-1' })).toEqual({ voices: ['alloy'] });
  fetch.mockImplementationOnce(async () => Response.json({ provider: 'speech', model: 'tts-1', nextCursor: null, data: [{ id: 'alloy', name: 'alloy' }, { id: 'clone:mine', name: 'My voice' }] }));
  expect(await getVoices({ provider: 'speech', model: 'tts-1' })).toEqual({ voices: ['alloy'] });
  expect(fetch).toHaveBeenCalledWith('/api/v1/voices?provider=speech&model=tts-1', { signal: undefined });
});

test('default discovery follows only the caller saved provider and model', async () => {
  state.sqlite.prepare('insert into user_preferences values (?,?)').run('alice', JSON.stringify({ providerRef: 'personal', providerType: 'openai', ttsModel: 'gpt-4o-mini-tts' }));
  state.sqlite.prepare('insert into user_preferences values (?,?)').run('bob', JSON.stringify({ providerRef: 'speech', providerType: 'openai', ttsModel: 'tts-1' }));
  state.credentials.mockResolvedValue({ provider: 'openai', apiKey: '', adminRecord: { slug: 'personal', providerType: 'openai', defaultModel: 'tts-1' } });
  const response = await GET(new NextRequest('http://localhost/api/v1/voices'));
  expect(response.status).toBe(200);
  expect(state.credentials).toHaveBeenCalledWith({ providerHeader: 'personal', fallbackProvider: 'speech' });
  expect(await response.json()).toMatchObject({ provider: 'personal', model: 'gpt-4o-mini-tts' });
});
