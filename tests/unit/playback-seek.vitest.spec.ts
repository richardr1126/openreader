import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { usePlaybackSeek } from '@/hooks/audio/usePlaybackSeek';
import { useTtsDocumentNavigation } from '@/hooks/audio/useTtsDocumentNavigation';
import { planCanonicalTtsSegments } from '@openreader/tts/segment-plan';
import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';

let root: Root;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root') as unknown as HTMLElement);
});
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function layout(generated = true): TtsPlaybackSeekLayout {
  return {
    planId: 'plan', sessionId: 'session', status: 'running', startOrdinal: 0, generationStartOrdinal: 0, durationMs: 60_000,
    segments: [0, 1, 2].map((ordinal) => ({
      ordinal, startMs: ordinal * 20_000, endMs: (ordinal + 1) * 20_000, durationMs: 20_000,
      generated, estimated: !generated, audioState: generated ? 'ready' : 'pending',
      durationSource: generated ? 'exact' : 'estimated', locator: { readerType: 'html', location: '1' },
      segmentKey: `segment-${ordinal}`, alignment: null,
    })),
  };
}

async function fixture() {
  const play = vi.fn(async () => undefined);
  const input: Parameters<typeof usePlaybackSeek>[0] = {
    audioRef: { current: { src: 'http://localhost/audio', error: null, play, pause: vi.fn() } as unknown as HTMLAudioElement },
    audioSpeed: 1, isPlayingRef: { current: true }, onPendingSeekExpired: vi.fn(),
    playbackActiveRef: { current: true }, playbackRunIdRef: { current: 1 }, playbackSeekLayout: layout(),
    playbackSessionRef: { current: { sessionId: 'session', sessionInstanceId: 'instance', planId: 'plan', audioUrl: '/audio', timelineUrl: '/timeline' } },
    cancelMediaPosition: vi.fn(), projectPlaybackTime: vi.fn(), publishPlaybackTimeSec: vi.fn(),
    setAudioDocumentTime: vi.fn(async () => true), setPlaybackPhase: vi.fn(),
    setSelectedOrdinal: vi.fn(), syncPlaybackLocator: vi.fn(), updateWorkerPlaybackCursor: vi.fn(),
  };
  let controller!: ReturnType<typeof usePlaybackSeek>;
  function Probe() { controller = usePlaybackSeek(input); return null; }
  const render = () => act(async () => root.render(createElement(Probe)));
  await render();
  return { input, play, render, get controller() { return controller; } };
}

describe('playback seek ownership', () => {
  test.each(['pdf', 'epub'] as const)('browsing a %s surface preserves the live cursor and audio owner', async (readerType) => {
    const locator = readerType === 'pdf'
      ? { readerType: 'pdf' as const, page: 2 }
      : { readerType: 'epub' as const, spineIndex: 0, spineHref: 'chapter.xhtml', charOffset: 0 };
    const segments = planCanonicalTtsSegments([
      { sourceKey: 'one', text: 'First sentence.', locator },
      { sourceKey: 'two', text: 'Second sentence.', locator },
    ], { readerType, enforceSourceBoundaries: true }).segments;
    const plan = { sessionId: 'canonical', documentId: 'book', readerType, segments: [] };
    const input: Parameters<typeof useTtsDocumentNavigation>[0] = {
      activeReaderType: readerType, isPlaying: true, sentences: segments.map((entry) => entry.text),
      advanceRef: { current: null }, isPlayingRef: { current: true }, pauseEpochRef: { current: 0 },
      playbackAnchorRef: { current: null }, playbackPlanReady: true, playbackPlanRef: { current: plan },
      playbackSegmentsRef: { current: segments }, selectedOrdinalRef: { current: 1 },
      cancelPendingSeek: vi.fn(), pauseActivePlayback: vi.fn(), seekPlaybackToOrdinal: vi.fn(),
      syncActivePlaybackToOrdinal: vi.fn(), selectPlaybackSegment: vi.fn(), setCurrDocPage: vi.fn(),
      setIsPlaying: vi.fn(), setIsProcessing: vi.fn(), setPlaybackAnchor: vi.fn(),
      setSelectedOrdinal: vi.fn(), syncPlaybackLocator: vi.fn(),
    };
    let navigation!: ReturnType<typeof useTtsDocumentNavigation>;
    function Probe() { navigation = useTtsDocumentNavigation(input); return null; }
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      if (readerType === 'pdf') navigation.setDocumentPlaybackAnchor(2, true, locator);
      else {
        navigation.reconcileEpubRenderedAnchor({ locator, hasReadableText: true, preservePlaybackCursor: true });
        navigation.reconcileEpubRenderedAnchor({ locator: null, hasReadableText: false, preservePlaybackCursor: true });
      }
    });
    expect(input.setCurrDocPage).toHaveBeenCalled();
    expect(input.setSelectedOrdinal).not.toHaveBeenCalled();
    expect(input.seekPlaybackToOrdinal).not.toHaveBeenCalled();
    expect(input.syncActivePlaybackToOrdinal).not.toHaveBeenCalled();
    expect(input.pauseActivePlayback).not.toHaveBeenCalled();
    expect(input.setIsPlaying).not.toHaveBeenCalled();
    expect(input.playbackPlanRef.current).toBe(plan);
    expect(input.selectedOrdinalRef.current).toBe(1);
  });

  test('generation progress preserves a slow seek and cached readiness hands its deadline to media positioning', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    let acceptPosition!: (accepted: boolean) => void;
    vi.mocked(f.input.setAudioDocumentTime).mockImplementation(() => new Promise((resolve) => { acceptPosition = resolve; }));
    f.input.playbackSeekLayout = layout(false);
    await f.render();
    await act(async () => f.controller.seekPlaybackTo(0));
    await act(async () => vi.advanceTimersByTimeAsync(45_000));
    const firstProgress = layout(false);
    firstProgress.segments[1] = layout().segments[1];
    f.input.playbackSeekLayout = firstProgress;
    await f.render();
    await act(async () => vi.advanceTimersByTimeAsync(55_000));
    expect(f.input.onPendingSeekExpired).not.toHaveBeenCalled();
    f.input.playbackSeekLayout = { ...firstProgress, segments: [firstProgress.segments[0], ...layout().segments.slice(1)] };
    await f.render();
    await act(async () => vi.advanceTimersByTimeAsync(19_000));
    f.input.playbackSeekLayout = layout();
    await f.render();
    expect(f.input.setAudioDocumentTime).toHaveBeenCalledTimes(1);
    // Audio became ready at 119s. The browser's positioning budget owns this
    // phase, rather than the readiness hard cap expiring at 120s.
    await act(async () => vi.advanceTimersByTimeAsync(25_000));
    expect(f.input.onPendingSeekExpired).not.toHaveBeenCalled();
    await act(async () => acceptPosition(true));
    expect(f.controller.hasPendingSeek()).toBe(false);
    expect(f.play).toHaveBeenCalledTimes(1);
  });

  test('an active seek still expires when SSE never reports its target ready', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.input.playbackSeekLayout = layout(false);
    await f.render();
    await act(async () => f.controller.seekPlaybackTo(45));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(f.controller.hasPendingSeek()).toBe(false);
    expect(f.input.onPendingSeekExpired).toHaveBeenCalledTimes(1);
    expect(f.play).not.toHaveBeenCalled();
  });

  test('rapid sentence skips use the latest target before another render', async () => {
    const segments = planCanonicalTtsSegments([
      { sourceKey: 'one', text: 'First sentence.', locator: { readerType: 'html', location: '1' } },
      { sourceKey: 'two', text: 'Second sentence.', locator: { readerType: 'html', location: '1' } },
      { sourceKey: 'three', text: 'Third sentence.', locator: { readerType: 'html', location: '1' } },
    ], { readerType: 'html', enforceSourceBoundaries: true }).segments;
    const selectedOrdinalRef = { current: 0 as number | null };
    const seek = vi.fn((ordinal: number) => { selectedOrdinalRef.current = ordinal; return true; });
    const input: Parameters<typeof useTtsDocumentNavigation>[0] = {
      activeReaderType: 'html', isPlaying: true, sentences: segments.map((segment) => segment.text),
      advanceRef: { current: null }, isPlayingRef: { current: true }, pauseEpochRef: { current: 0 },
      playbackAnchorRef: { current: null }, playbackPlanReady: true, playbackPlanRef: { current: null },
      playbackSegmentsRef: { current: segments }, selectedOrdinalRef,
      cancelPendingSeek: vi.fn(), pauseActivePlayback: vi.fn(), seekPlaybackToOrdinal: seek,
      syncActivePlaybackToOrdinal: vi.fn(), selectPlaybackSegment: vi.fn(), setCurrDocPage: vi.fn(),
      setIsPlaying: vi.fn(), setIsProcessing: vi.fn(), setPlaybackAnchor: vi.fn(),
      setSelectedOrdinal: vi.fn(), syncPlaybackLocator: vi.fn(),
    };
    let navigation!: ReturnType<typeof useTtsDocumentNavigation>;
    function Probe() { navigation = useTtsDocumentNavigation(input); return null; }
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      void navigation.skipForward();
      void navigation.skipForward();
      void navigation.skipBackward();
    });
    expect(seek.mock.calls.map(([ordinal]) => ordinal)).toEqual([1, 2, 1]);
    expect(input.setIsPlaying).not.toHaveBeenCalled();
  });

  test('idle scrubbing selects an ungenerated target without creating a media wait', async () => {
    const f = await fixture();
    f.input.playbackActiveRef.current = false;
    f.input.isPlayingRef.current = false;
    f.input.playbackSessionRef.current = null;
    f.input.playbackSeekLayout = layout(false);
    await f.render();
    await act(async () => f.controller.seekPlaybackTo(45));
    expect(f.input.setSelectedOrdinal).toHaveBeenLastCalledWith(2);
    expect(f.input.publishPlaybackTimeSec).toHaveBeenLastCalledWith(40, { force: true });
    expect(f.controller.hasPendingSeek()).toBe(false);
    expect(f.input.updateWorkerPlaybackCursor).not.toHaveBeenCalled();
    expect(f.input.setAudioDocumentTime).not.toHaveBeenCalled();
    expect(f.play).not.toHaveBeenCalled();
  });

  test('a cached target chosen during startup remains pending until a media owner exists', async () => {
    const f = await fixture();
    f.input.playbackActiveRef.current = false;
    f.input.playbackSessionRef.current = null;
    await act(async () => f.controller.seekPlaybackTo(45));
    expect(f.controller.getPendingSeekOrdinal()).toBe(2);
    expect(f.controller.getPendingSeekOffsetSec()).toBe(5);
    expect(f.input.updateWorkerPlaybackCursor).toHaveBeenLastCalledWith(2);
    expect(f.input.setAudioDocumentTime).not.toHaveBeenCalled();
  });

  test('only the latest accepted media position may complete a cached seek', async () => {
    const f = await fixture();
    const releases: Array<(accepted: boolean) => void> = [];
    vi.mocked(f.input.setAudioDocumentTime).mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    await act(async () => f.controller.seekPlaybackTo(25));
    await act(async () => f.controller.seekPlaybackTo(45));
    expect(releases).toHaveLength(2);
    await act(async () => releases[0](true));
    expect(f.controller.getPendingSeekOrdinal()).toBe(2);
    expect(f.play).not.toHaveBeenCalled();
    await act(async () => releases[1](true));
    expect(f.controller.hasPendingSeek()).toBe(false);
    expect(f.play).toHaveBeenCalledTimes(1);
    expect(f.input.projectPlaybackTime).toHaveBeenLastCalledWith(45);
  });

  test('late exact durations preserve the target ordinal and its in-segment offset', async () => {
    const f = await fixture();
    let release!: (accepted: boolean) => void;
    vi.mocked(f.input.setAudioDocumentTime).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await act(async () => f.controller.seekPlaybackTo(45));
    const corrected = layout();
    corrected.segments[0] = { ...corrected.segments[0], durationMs: 5_000, endMs: 5_000 };
    corrected.segments[1] = { ...corrected.segments[1], startMs: 5_000, endMs: 25_000 };
    corrected.segments[2] = { ...corrected.segments[2], startMs: 25_000, endMs: 45_000 };
    corrected.durationMs = 45_000;
    f.input.playbackSeekLayout = corrected;
    await f.render();
    expect(f.input.setAudioDocumentTime).toHaveBeenCalledTimes(1);
    await act(async () => release(true));
    expect(f.input.setSelectedOrdinal).toHaveBeenLastCalledWith(2);
    expect(f.input.projectPlaybackTime).toHaveBeenLastCalledWith(30);
  });

  test('pause cancels an outstanding media transition without late autoplay', async () => {
    const f = await fixture();
    let release!: (accepted: boolean) => void;
    vi.mocked(f.input.setAudioDocumentTime).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await act(async () => f.controller.seekPlaybackTo(45));
    f.input.isPlayingRef.current = false;
    await act(async () => f.controller.cancelPendingSeek());
    await act(async () => release(true));
    expect(f.controller.hasPendingSeek()).toBe(false);
    expect(f.play).not.toHaveBeenCalled();
    expect(f.input.onPendingSeekExpired).not.toHaveBeenCalled();
  });

  test('a rejected browser seek settles with failure rather than silently completing', async () => {
    const f = await fixture();
    vi.mocked(f.input.setAudioDocumentTime).mockRejectedValueOnce(new Error('browser rejected seek'));
    await act(async () => f.controller.seekPlaybackTo(45));
    expect(f.input.onPendingSeekExpired).toHaveBeenCalledTimes(1);
    expect(f.controller.hasPendingSeek()).toBe(false);
    expect(f.play).not.toHaveBeenCalled();
  });
});
