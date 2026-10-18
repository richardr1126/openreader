import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useTtsPlayback } from '@/hooks/audio/useTtsPlayback';
import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';
import type { TtsPlaybackPlan } from '@/lib/shared/playback-plan';
import { planCanonicalTtsSegments } from '@openreader/tts/segment-plan';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(), recovery: vi.fn(), foreground: vi.fn(),
  activity: vi.fn(async () => undefined), stop: vi.fn(), refresh: vi.fn(),
}));
vi.mock('@/lib/client/api/tts', () => ({ createTtsPlaybackSession: mocks.createSession }));
vi.mock('@/lib/client/tts/playback-recovery', () => ({ createTtsMediaRecovery: mocks.recovery }));
vi.mock('@/hooks/audio/usePlaybackForegroundSync', () => ({ usePlaybackForegroundSync: mocks.foreground }));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }));

class TestAudio extends EventTarget {
  static instance: TestAudio;
  src = '';
  currentTime = 0;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  readyState = 4;
  seeking = false;
  paused = true;
  ended = false;
  error = null;
  onplay: ((event: Event) => void) | null = null;
  onpause: ((event: Event) => void) | null = null;
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  ontimeupdate: ((event: Event) => void) | null = null;
  onwaiting: ((event: Event) => void) | null = null;
  onstalled: ((event: Event) => void) | null = null;
  onplaying: ((event: Event) => void) | null = null;
  constructor() { super(); TestAudio.instance = this; }
  setAttribute() {}
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() { this.currentTime = 0; }
  async play() {
    this.paused = false;
    this.onplay?.(new Event('play'));
    this.onplaying?.(new Event('playing'));
  }
  pause() { this.paused = true; this.onpause?.(new Event('pause')); }
}

const segments = planCanonicalTtsSegments([
  { sourceKey: 'one', text: 'First sentence.', locator: { readerType: 'html', location: '1' } },
  { sourceKey: 'two', text: 'Second sentence.', locator: { readerType: 'html', location: '1' } },
], { readerType: 'html', enforceSourceBoundaries: true }).segments;
const layout: TtsPlaybackSeekLayout = {
  planId: 'plan', sessionId: 'canonical', status: 'running', startOrdinal: 0,
  generationStartOrdinal: 1, durationMs: 40_000,
  segments: segments.map((segment) => ({
    ordinal: segment.ordinal, segmentKey: segment.key, startMs: segment.ordinal * 20_000,
    endMs: (segment.ordinal + 1) * 20_000, durationMs: 20_000, generated: true,
    estimated: false, audioState: 'ready', durationSource: 'exact', alignment: null,
    locator: segment.ownerLocator,
  })),
};
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  Object.defineProperty(window, 'location', { configurable: true, value: { href: 'http://localhost/reader' } });
  vi.stubGlobal('document', document);
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('Audio', TestAudio);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => layout })));
  mocks.createSession.mockImplementation(async () => ({
    sessionId: 'canonical', sessionInstanceId: `instance-${mocks.createSession.mock.calls.length}`,
    audioUrl: '/audio', timelineUrl: '/timeline',
  }));
  mocks.recovery.mockReturnValue({ check: vi.fn(), stop: vi.fn() });
  mocks.foreground.mockImplementation((input: { setPlaybackSeekLayout: (value: TtsPlaybackSeekLayout) => void }) => ({
    modelDownload: null, setWorkerPlaybackActive: mocks.activity,
    startPlaybackForegroundSync: () => input.setPlaybackSeekLayout({ ...layout }),
    stopPlaybackForegroundSync: mocks.stop, updateWorkerPlaybackCursor: vi.fn(),
    refreshPlaybackOverview: mocks.refresh,
  }));
  root = createRoot(document.getElementById('root') as unknown as HTMLElement);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

test('Play after recovery exhaustion reinstalls media events and advances the preserved cursor', async () => {
  let playback!: ReturnType<typeof useTtsPlayback>;
  const plan: TtsPlaybackPlan = {
    planId: 'plan', planObjectKey: 'plans/document', sessionId: 'canonical',
    documentId: 'document', readerType: 'html',
    segments: segments.map((segment) => ({
      ordinal: segment.ordinal, segmentKey: segment.key, text: segment.text, locator: segment.ownerLocator,
    })),
  };
  const request = {
    headers: { 'Content-Type': 'application/json', 'x-tts-provider': 'kitten' },
    payload: { documentId: 'document', settings: {
      providerRef: 'kitten', providerType: 'custom-openai' as const, ttsModel: 'KittenTTS',
      voice: 'Bella', nativeSpeed: 1, language: 'en',
    } },
  };
  function Probe() {
    const [isPlaying, setIsPlaying] = useState(false);
    const [seekLayout, setSeekLayout] = useState<TtsPlaybackSeekLayout | null>(layout);
    const selectedOrdinalRef = useRef<number | null>(1);
    const isPlayingRef = useRef(false);
    playback = useTtsPlayback({
      audioContext: null, audioSpeed: 1, canStartPlayback: true, isPlaying, isPlayingRef,
      playbackSegmentsRef: useRef(segments), playbackSeekLayout: seekLayout,
      selectedOrdinal: selectedOrdinalRef.current, selectedOrdinalRef, playbackRunIdRef: useRef(0),
      setIsPlaying, setCurrDocPage: vi.fn(), setSelectedOrdinal: (ordinal) => { selectedOrdinalRef.current = ordinal; },
      setPlaybackSeekLayout: setSeekLayout, setCurrentSentenceAlignment: vi.fn(), setCurrentWordIndex: vi.fn(), onAdvance: vi.fn(),
      controller: {
        buildPlaybackPlanRequest: () => request,
        buildPlaybackSessionRequest: () => ({ ...request, selectedOrdinal: selectedOrdinalRef.current ?? 0 }),
        getPlaybackPlan: () => plan, applyPlaybackPlan: (value) => value,
      },
    });
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  await act(async () => playback.togglePlay());
  await vi.waitFor(() => expect(mocks.recovery).toHaveBeenCalledTimes(1));
  const audio = TestAudio.instance;
  await act(async () => { audio.currentTime = 2; audio.ontimeupdate?.(new Event('timeupdate')); });
  expect(playback.playbackPhase).toBe('playing');
  expect(playback.playbackTimeSec).toBe(22);

  await act(async () => mocks.recovery.mock.calls[0][0].onExhausted());
  expect(audio.onplaying).toBeNull();
  expect(playback.playbackActiveRef.current).toBe(false);
  expect(playback.playbackPhase).toBe('failed');
  expect(playback.playbackTimeSec).toBe(22);

  await act(async () => playback.togglePlay());
  await vi.waitFor(() => expect(mocks.recovery).toHaveBeenCalledTimes(2));
  expect(mocks.createSession).toHaveBeenCalledTimes(2);
  expect(mocks.createSession.mock.calls[1][0]).toMatchObject({ planId: 'plan', startIntent: { selectedOrdinal: 1 } });
  expect(playback.playbackPhase).toBe('playing');
  expect(audio.onplaying).toBeTypeOf('function');
  await act(async () => { audio.currentTime = 5; audio.ontimeupdate?.(new Event('timeupdate')); });
  expect(playback.playbackTimeSec).toBe(25);
});
