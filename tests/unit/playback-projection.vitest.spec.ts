import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { describe, expect, test, vi } from 'vitest';

import { shouldSyncPlaybackLocator, usePlaybackProjection } from '@/hooks/audio/usePlaybackProjection';
import { normalizePlaybackGrid } from '@/lib/client/tts/playback-grid';

describe('playback locator projection', () => {
  test.each(['buffered', 'evicted', 'gap', 'forced', 'error', 'rebased', 'same-evicted', 'same-loading'] as const)(
    'cached seeks reuse only real, downloaded audio: %s', async (scenario) => {
      const dom = parseHTML('<html><body><div id="root"></div></body></html>');
      Object.defineProperty(dom.window, 'location', { value: { href: 'http://localhost/' }, configurable: true });
      vi.stubGlobal('window', dom.window);
      vi.stubGlobal('document', dom.document);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const root = createRoot(dom.document.getElementById('root') as unknown as HTMLElement);
      const session = { sessionId: 'session', sessionInstanceId: 'instance', planId: 'plan',
        timelineUrl: '/timeline', audioUrl: 'http://localhost/audio' };
      const grid = (gap = false, prefixMs = 5000) => normalizePlaybackGrid({ sessionId: 'session', status: 'running',
        segments: [
          { ordinal: 0, startMs: 0, endMs: prefixMs, durationMs: prefixMs },
          ...[1, 2, 3].map((ordinal) => ({ ordinal, startMs: prefixMs + (ordinal - 1) * 20_000,
            endMs: prefixMs + ordinal * 20_000, durationMs: 20_000, generated: !(gap && ordinal === 2) })),
        ],
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => grid(scenario === 'gap') })
        .mockResolvedValueOnce({ ok: true, json: async () => grid(false, scenario === 'rebased' ? 1000 : 5000) }));
      let projection!: ReturnType<typeof usePlaybackProjection>;
      function Probe() {
        projection = usePlaybackProjection({ playbackRunIdRef: { current: 1 }, playbackSessionRef: { current: session },
          selectedOrdinalRef: { current: 1 }, setCurrentSentenceAlignment: vi.fn(),
          setCurrentWordIndex: vi.fn(), setSelectedOrdinal: vi.fn() });
        return null;
      }
      const load = vi.fn();
      const buffered = { length: 1, start: () => 0, end: () => scenario === 'evicted' ? 10 : 60 };
      const audio = Object.assign(new EventTarget(), { src: '', error: null, currentTime: 0,
        readyState: 2, seeking: false, load,
        buffered,
      }) as unknown as HTMLAudioElement;
      try {
        await act(async () => root.render(createElement(Probe)));
        await projection.refreshPlaybackTimeline('/timeline');
        await projection.setAudioDocumentTime(audio, 5, 1, 5, { reopenStream: true });
        expect(load).toHaveBeenCalledTimes(1);
        await projection.refreshPlaybackTimeline('/timeline');
        if (scenario === 'error') Object.defineProperty(audio, 'error', { value: { code: 2 } });
        if (scenario === 'same-evicted') buffered.start = () => 10;
        if (scenario === 'same-loading') {
          buffered.length = 0;
          Object.defineProperty(audio, 'readyState', { value: 0, writable: true });
        }
        const sameOrdinal = scenario === 'same-evicted' || scenario === 'same-loading';
        const targetOrdinal = sameOrdinal ? 1 : 2;
        const targetSec = sameOrdinal ? 5 : scenario === 'rebased' ? 21 : 25;
        const positioning = projection.setAudioDocumentTime(audio, targetSec, targetOrdinal, targetSec, { reopenStream: scenario === 'forced' });
        if (scenario === 'same-loading') {
          expect(load).toHaveBeenCalledTimes(1);
          Object.defineProperty(audio, 'readyState', { value: 2 });
          audio.dispatchEvent(new Event('loadeddata'));
        }
        await positioning;
        const reused = scenario === 'buffered' || scenario === 'rebased' || scenario === 'same-loading';
        expect(load).toHaveBeenCalledTimes(reused ? 1 : 2);
        expect(new URL(audio.src).searchParams.get('fromOrdinal')).toBe(reused ? '1' : String(targetOrdinal));
        expect(audio.currentTime).toBe(reused && !sameOrdinal ? 20 : 0);
        expect(projection.documentTimeForAudio(audio)).toBe(targetSec);
      } finally {
        await act(async () => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  test('navigates the renderer only when the projected locator changes', () => {
    expect(shouldSyncPlaybackLocator(undefined, 'epub|4|chapter.xhtml|120')).toBe(true);
    expect(shouldSyncPlaybackLocator(
      'epub|4|chapter.xhtml|120',
      'epub|4|chapter.xhtml|120',
    )).toBe(false);
    expect(shouldSyncPlaybackLocator(
      'epub|4|chapter.xhtml|120',
      'epub|4|chapter.xhtml|180',
    )).toBe(true);
    expect(shouldSyncPlaybackLocator('epub|4|chapter.xhtml|120', '')).toBe(false);
  });

  test('rebases deep-start highlighting when earlier cached durations arrive without restarting audio', async () => {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(dom.document.getElementById('root') as unknown as HTMLElement);
    const session = { sessionId: 'session', sessionInstanceId: 'instance', planId: 'plan',
      timelineUrl: '/timeline', audioUrl: 'http://localhost/audio' };
    const word = vi.fn();
    const alignment = { sentenceIndex: 1, sentence: 'Hello world',
      words: [{ text: 'Hello', startSec: 0, endSec: 0.5 }, { text: 'world', startSec: 0.5, endSec: 1.2 }] };
    const grid = normalizePlaybackGrid({ sessionId: 'session', status: 'running', generationStartOrdinal: 1,
      segments: [
        { ordinal: 0, startMs: 0, endMs: 5000, durationMs: 5000 },
        { ordinal: 1, startMs: 5000, endMs: 7000, durationMs: 2000, generated: true, alignment },
      ],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => grid })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...grid, segments: [
        { ...grid.segments[0], durationMs: 1000, endMs: 1000, generated: true },
        { ...grid.segments[1], startMs: 1000, endMs: 3000 },
      ] }) }));
    let projection!: ReturnType<typeof usePlaybackProjection>;
    function Probe() {
      projection = usePlaybackProjection({
        playbackRunIdRef: { current: 1 }, playbackSessionRef: { current: session },
        selectedOrdinalRef: { current: 1 },
        setCurrentSentenceAlignment: vi.fn(), setCurrentWordIndex: word, setSelectedOrdinal: vi.fn(),
      });
      return null;
    }
    try {
      await act(async () => root.render(createElement(Probe)));
      await projection.refreshPlaybackTimeline('/timeline', undefined, { minOrdinal: 1, limit: 64 });
      projection.setPlaybackStreamAnchor(1, 5);
      const audio = { currentTime: 0.75 } as HTMLAudioElement;
      projection.projectPlaybackTime(projection.documentTimeForAudio(audio));
      expect(word).toHaveBeenLastCalledWith(1);
      await projection.refreshPlaybackTimeline('/timeline');
      expect(audio.currentTime).toBe(0.75);
      expect(projection.documentTimeForAudio(audio)).toBe(1.75);
      projection.projectPlaybackTime(projection.documentTimeForAudio(audio));
      expect(word).toHaveBeenLastCalledWith(1);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
