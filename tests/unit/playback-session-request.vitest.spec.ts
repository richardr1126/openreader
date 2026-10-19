import { afterEach, expect, test, vi } from 'vitest';
import { createTtsPlaybackSession, type TtsPlaybackSessionPayload } from '@/lib/client/api/tts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each(['deadline', 'cancellation'])('session preparation propagates %s while keeping the other abort source', async (source) => {
  const deadline = new AbortController();
  const caller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  })));
  const payload: TtsPlaybackSessionPayload = {
    documentId: 'document', planObjectKey: 'plan', startIntent: { selectedOrdinal: 0 },
    settings: { providerRef: 'kitten', providerType: 'custom-openai', ttsModel: 'KittenTTS', voice: 'Bella', nativeSpeed: 1, language: 'en' },
  };
  const request = createTtsPlaybackSession(payload, {}, caller.signal);
  const reason = source === 'deadline'
    ? new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    : new DOMException('Aborted', 'AbortError');
  const rejected = expect(request).rejects.toBe(reason);
  (source === 'deadline' ? deadline : caller).abort(reason);
  await rejected;
  expect(timeout).toHaveBeenCalledWith(30_000);
});
