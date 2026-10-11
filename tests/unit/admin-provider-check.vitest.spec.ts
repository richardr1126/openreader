import { describe, expect, test, vi } from 'vitest';
import { runProviderCheck, type ProviderCheckDeps, type ProviderCheckDraft } from '../../src/lib/server/admin/provider-check';

const draft = (overrides: Partial<ProviderCheckDraft> = {}): ProviderCheckDraft => ({
  providerType: 'custom-openai',
  baseUrl: 'http://tts.local:8880/v1',
  apiKey: '',
  defaultModel: 'kokoro',
  defaultInstructions: '',
  ...overrides,
});

function deps(overrides: Partial<ProviderCheckDeps> = {}): ProviderCheckDeps {
  return {
    fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch,
    resolveVoices: vi.fn(async () => ['af_sarah', 'am_adam']),
    workerAvailable: () => true,
    synthesizePreview: vi.fn(async () => ({ ok: true as const, audio: new ArrayBuffer(4096) })),
    ...overrides,
  };
}

const signal = new AbortController().signal;
const statuses = (items: Awaited<ReturnType<typeof runProviderCheck>>) =>
  Object.fromEntries(items.map((item) => [item.id, item.status]));

describe('admin provider check', () => {
  test('stops at settings when a custom provider has no base URL', async () => {
    const d = deps();
    const items = await runProviderCheck(draft({ baseUrl: '' }), null, d, signal);
    expect(statuses(items)).toEqual({ settings: 'error' });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  test('requires a key for hosted providers', async () => {
    const items = await runProviderCheck(draft({ providerType: 'openai', baseUrl: '' }), null, deps(), signal);
    expect(items[0]).toMatchObject({ id: 'settings', status: 'error', detail: 'This provider needs an API key.' });
  });

  test('checks a Deepinfra draft against its default base URL and skips speech until created', async () => {
    const d = deps();
    const items = await runProviderCheck(
      draft({ providerType: 'deepinfra', baseUrl: '', apiKey: 'secret-key', defaultModel: 'hexgrad/Kokoro-82M' }),
      null,
      d,
      signal,
    );
    expect(vi.mocked(d.fetch).mock.calls[0][0]).toBe('https://api.deepinfra.com/v1/openai/models');
    expect(statuses(items)).toEqual({ settings: 'ok', connection: 'ok', voices: 'ok', speech: 'skipped' });
    expect(d.synthesizePreview).not.toHaveBeenCalled();
    expect(JSON.stringify(items)).not.toContain('secret-key');
  });

  test('reports a rejected key and skips the remaining checks', async () => {
    const d = deps({ fetch: vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch });
    const items = await runProviderCheck(draft({ apiKey: 'bad' }), null, d, signal);
    expect(items.at(-1)).toMatchObject({ id: 'connection', status: 'error', detail: 'tts.local:8880 rejected the API key.' });
    expect(d.resolveVoices).not.toHaveBeenCalled();
  });

  test('treats a custom server without /models as reachable', async () => {
    const d = deps({ fetch: vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch });
    const items = await runProviderCheck(draft(), null, d, signal);
    expect(statuses(items).connection).toBe('ok');
  });

  test('reports an unreachable server', async () => {
    const d = deps({ fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    const items = await runProviderCheck(draft(), null, d, signal);
    expect(items.at(-1)).toMatchObject({ id: 'connection', status: 'error' });
  });

  test('warns when OpenAI does not list the model for the key', async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 })) as unknown as typeof fetch,
    });
    const items = await runProviderCheck(draft({ providerType: 'openai', baseUrl: '', apiKey: 'k', defaultModel: 'tts-1' }), null, d, signal);
    expect(statuses(items).connection).toBe('warn');
  });

  test('speaks a sample through the worker for a saved, unchanged provider', async () => {
    const d = deps();
    const items = await runProviderCheck(draft(), { slug: 'kokoro-prod', enabled: true, matchesDraft: true }, d, signal);
    expect(statuses(items).speech).toBe('ok');
    expect(vi.mocked(d.synthesizePreview).mock.calls[0][0]).toMatchObject({
      settings: { providerRef: 'kokoro-prod', ttsModel: 'kokoro', voice: 'af_sarah', nativeSpeed: 1 },
    });
  });

  test('skips speech for unsaved edits or a disabled provider', async () => {
    const changed = await runProviderCheck(draft(), { slug: 'p', enabled: true, matchesDraft: false }, deps(), signal);
    const disabled = await runProviderCheck(draft(), { slug: 'p', enabled: false, matchesDraft: true }, deps(), signal);
    expect(changed.at(-1)).toMatchObject({ id: 'speech', status: 'skipped' });
    expect(disabled.at(-1)).toMatchObject({ id: 'speech', status: 'skipped' });
  });

  test('explains a provider rejection from the worker', async () => {
    const d = deps({
      synthesizePreview: vi.fn(async () => ({ ok: false as const, status: 502, code: 'UPSTREAM_ERROR', retryAfterMs: null })),
    });
    const items = await runProviderCheck(draft(), { slug: 'p', enabled: true, matchesDraft: true }, d, signal);
    expect(items.at(-1)).toMatchObject({ id: 'speech', status: 'error' });
  });

  test('checks a Replicate model with the key', async () => {
    const d = deps({ fetch: vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch });
    const items = await runProviderCheck(
      draft({ providerType: 'replicate', baseUrl: '', apiKey: 'r8', defaultModel: 'owner/missing' }),
      null,
      d,
      signal,
    );
    expect(vi.mocked(d.fetch).mock.calls[0][0]).toBe('https://api.replicate.com/v1/models/owner/missing');
    expect(items.at(-1)).toMatchObject({ id: 'connection', status: 'error' });
  });
});
