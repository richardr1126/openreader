import { afterEach, describe, expect, test, vi } from 'vitest';
import { clonedVoiceKey, validateReferenceWav, type StoredClonedVoice } from '@openreader/tts/cloned-voices';
import { pcmToWav } from '@openreader/tts/openrouter';
import { buildTTSCacheKey, generateTTSBuffer } from '@openreader/tts/generate';
import { resolveClonedVoice } from '../../packages/compute-worker/src/jobs/playback/cloned-voice';
import { fishReferenceRequest } from '@openreader/tts/fish-audio';
vi.mock('@openreader/tts/audio-format', () => ({ normalizeToMp3: vi.fn(async (audio: Buffer) => audio),
  appendCbrSilence: vi.fn(async (audio: Buffer) => audio) }));

const id = 'clone:7e94cb5c-1032-44b8-84ee-8a7a6f99d629';
const wav = pcmToWav(new Uint8Array(48_000));
const stored: StoredClonedVoice = { id, name: 'My narrator', providerRef: 'router', providerType: 'openrouter',
  model: 'fish-audio/s2.1-pro-free:free', audio: Buffer.from(wav).toString('base64'), transcript: 'Reference words.' };
const settings = { providerRef: stored.providerRef, providerType: stored.providerType, ttsModel: stored.model, voice: id, nativeSpeed: 1 };
afterEach(() => vi.unstubAllGlobals());

describe('private cloned voice execution', () => {
  test('validates duration, format and truncated WAV headers', () => {
    expect(() => validateReferenceWav(wav)).not.toThrow();
    for (const bytes of [new Uint8Array(0), wav.slice(0, 50), pcmToWav(new Uint8Array(800_000)), pcmToWav(new Uint8Array(48_000), 44_100)]) {
      expect(() => validateReferenceWav(bytes)).toThrow();
    }
  });
  test('addresses recordings by authenticated user and rejects path-shaped IDs', () => {
    expect(clonedVoiceKey('prefix', 'alice', id)).not.toBe(clonedVoiceKey('prefix', 'bob', id));
    expect(() => clonedVoiceKey('prefix', 'alice', 'clone:../../bob')).toThrow();
  });
  test('loads the recording only at execution and binds it to provider and model', async () => {
    const readObject = vi.fn(async () => Buffer.from(JSON.stringify(stored)));
    await expect(resolveClonedVoice({ settings, userId: 'alice', prefix: 'prefix', readObject })).resolves.toEqual({
      voice: 'default', referenceAudio: { audio: stored.audio, transcript: stored.transcript },
    });
    expect(readObject).toHaveBeenCalledWith(clonedVoiceKey('prefix', 'alice', id));
    for (const change of [{ providerRef: 'other' }, { ttsModel: 'fish-audio/drama-3' }, { providerType: 'fish-audio' as const }]) {
      await expect(resolveClonedVoice({ settings: { ...settings, ...change }, userId: 'alice', prefix: 'prefix', readObject })).rejects.toThrow('another provider or model');
    }
    await expect(resolveClonedVoice({ settings, prefix: 'prefix', readObject })).rejects.toThrow('unavailable');
    await expect(resolveClonedVoice({ settings, userId: 'bob', prefix: 'prefix', readObject: async () => { throw new Error('Not found'); } })).rejects.toThrow('Not found');
  });
  test('loads private reference audio for native Fish without an upstream model', async () => {
    const native = { ...stored, providerType: 'fish-audio', model: 's2.1-pro-free' };
    await expect(resolveClonedVoice({ settings: { ...settings, providerType: 'fish-audio', ttsModel: native.model },
      userId: 'alice', prefix: 'prefix', readObject: async () => Buffer.from(JSON.stringify(native)) })).resolves.toEqual({ voice: 'default', referenceAudio: { audio: stored.audio, transcript: stored.transcript } });
  });
  test('encodes the Fish binary reference contract and retains its free model', async () => {
    const reference = { audio: Buffer.from([0, 1, 255]).toString('base64'), transcript: 'Yo' };
    const bytes = fishReferenceRequest({ text: 'Hi', speed: 1.25, reference, language: 'en' });
    expect(Buffer.from(bytes).toString('hex')).toBe('85a474657874a24869a6666f726d6174a36d7033aa7265666572656e6365739182a5617564696fc6000000030001ffa474657874a2596fa770726f736f647981a57370656564cb3ff4000000000000a86c616e6775616765a2656e');
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2]))); vi.stubGlobal('fetch', fetch);
    await generateTTSBuffer({ provider: 'fish-audio', model: 's2.1-pro-free', apiKey: 'test-key', voice: 'default', speed: 1.25,
      text: 'Native Fish binary contract.', language: 'en', referenceAudio: reference });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/msgpack', model: 's2.1-pro-free' });
    expect(Buffer.from(init.body as Uint8Array)).toEqual(Buffer.from(fishReferenceRequest({ text: 'Native Fish binary contract.', speed: 1.25, reference, language: 'en' })));
  });
  test('sends OpenRouter inline WAV and transcript, omits a preset and preserves free variants', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { endpoints: [{ supports_voice_cloning: true }] } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2])));
    vi.stubGlobal('fetch', fetch);
    const request = { provider: 'openrouter', model: stored.model, voice: 'Sarah', speed: 1, text: 'A cloned narration contract.', apiKey: 'private-key',
      referenceAudio: { audio: stored.audio!, transcript: stored.transcript } };
    await generateTTSBuffer(request);
    expect(fetch.mock.calls[0][0]).toContain('s2.1-pro-free%3Afree/endpoints');
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body).toMatchObject({ model: stored.model, input_references: [
      { type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + stored.audio } }, { type: 'text', text: stored.transcript },
    ] });
    expect(body.voice).toBeUndefined();
    expect(buildTTSCacheKey(request)).not.toBe(buildTTSCacheKey({ ...request, referenceAudio: { ...request.referenceAudio, transcript: 'Different reference.' } }));
    expect(buildTTSCacheKey(request)).not.toContain('private-key');
    // Later segments reuse the discovered endpoint capabilities.
    fetch.mockResolvedValueOnce(new Response(new Uint8Array([3, 4])));
    await generateTTSBuffer({ ...request, text: 'The next segment.' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][0]).toContain('/audio/speech');
  });
});
