import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { usePlaybackForegroundSync } from '@/hooks/audio/usePlaybackForegroundSync';

const mocks = vi.hoisted(() => ({ postCursor: vi.fn(), subscribe: vi.fn() }));
vi.mock('@/lib/client/api/tts', () => ({
  postTtsPlaybackCursor: mocks.postCursor, subscribeTtsPlaybackEvents: mocks.subscribe,
}));
vi.mock('@/contexts/AuthRateLimitContext', () => ({ useAuthRateLimit: () => ({ refresh: vi.fn() }) }));
let root: Root;
beforeEach(() => {
  mocks.postCursor.mockReset().mockResolvedValue({ workerOpId: null });
  mocks.subscribe.mockReset().mockReturnValue(() => undefined);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root') as unknown as HTMLElement);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function fixture() {
  const input: Parameters<typeof usePlaybackForegroundSync>[0] = {
    playbackCursorOrdinalRef: { current: 10 },
    playbackRequestHeadersRef: { current: { 'Content-Type': 'application/json', 'x-tts-provider': 'kitten' } },
    playbackRunIdRef: { current: 1 },
    playbackSessionRef: { current: { sessionId: 'session', sessionInstanceId: 'instance', planId: 'plan', audioUrl: '/audio', timelineUrl: '/timeline' } },
    refreshPlaybackTimeline: vi.fn(), setPlaybackSeekLayout: vi.fn(),
  };
  let controller!: ReturnType<typeof usePlaybackForegroundSync>;
  function Probe() { controller = usePlaybackForegroundSync(input); return null; }
  await act(async () => root.render(createElement(Probe)));
  return { input, controller };
}

describe('foreground playback command ordering', () => {
  test('a slow activity write cannot arrive after a newer cursor write', async () => {
    const f = await fixture();
    let release!: (value: { workerOpId: null }) => void;
    mocks.postCursor.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const paused = f.controller.setWorkerPlaybackActive(false);
    await act(async () => Promise.resolve());
    f.controller.updateWorkerPlaybackCursor(42);
    expect(mocks.postCursor).toHaveBeenCalledTimes(1);
    await act(async () => { release({ workerOpId: null }); await paused; });
    expect(mocks.postCursor).toHaveBeenCalledTimes(2);
    expect(mocks.postCursor.mock.calls.map((call) => call[1])).toEqual([10, 42]);
    expect(mocks.postCursor.mock.calls[1][3]).not.toHaveProperty('playbackActive');
  });

  test('a queued activity update uses the newest target at dispatch', async () => {
    const f = await fixture();
    let release!: (value: { workerOpId: null }) => void;
    mocks.postCursor.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const paused = f.controller.setWorkerPlaybackActive(false);
    await act(async () => Promise.resolve());
    const resumed = f.controller.setWorkerPlaybackActive(true);
    f.input.playbackCursorOrdinalRef.current = 84;
    await act(async () => { release({ workerOpId: null }); await paused; await resumed; });
    expect(mocks.postCursor.mock.calls.map((call) => call[1])).toEqual([10, 84]);
    expect(mocks.postCursor.mock.calls[1][3]).toMatchObject({ playbackActive: true });
  });
});

describe('foreground playback readiness', () => {
  afterEach(() => { vi.useRealTimers(); });

  test('reads the timeline on operation snapshots, never on the cursor heartbeat', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const timeline = { sessionId: 'session', documentId: 'document', startOrdinal: 0, generationStartOrdinal: 0, status: 'running', durationMs: 0, segments: [] };
    vi.mocked(f.input.refreshPlaybackTimeline).mockResolvedValue(timeline);
    mocks.postCursor.mockResolvedValue({ workerOpId: 'op-1' });
    const snapshots = new Map<string, (snapshot: unknown) => void>();
    mocks.subscribe.mockImplementation((_sessionId: string, handlers: { onSnapshot: (snapshot: unknown) => void }, opId: string) => {
      snapshots.set(opId, handlers.onSnapshot);
      return () => undefined;
    });
    const reads = () => vi.mocked(f.input.refreshPlaybackTimeline).mock.calls.filter((call) => call[2]).length;

    await act(async () => { f.controller.startPlaybackForegroundSync(1); await vi.advanceTimersByTimeAsync(300); });
    expect(reads()).toBe(1);
    const progress = { status: 'running', completedThroughOrdinal: 12, completedCount: 3, plannedCount: 40 };
    await act(async () => { snapshots.get('op-1')!(progress); await vi.advanceTimersByTimeAsync(300); });
    expect(reads()).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(mocks.postCursor.mock.calls.length).toBeGreaterThanOrEqual(3);
    snapshots.get('op-1')!(progress);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(reads()).toBe(2);

    // A refill operation's first snapshot reads even when its progress matches.
    mocks.postCursor.mockResolvedValue({ workerOpId: 'op-2' });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    await act(async () => { snapshots.get('op-2')!(progress); await vi.advanceTimersByTimeAsync(300); });
    expect(reads()).toBe(3);
    f.controller.stopPlaybackForegroundSync();
  });
});
