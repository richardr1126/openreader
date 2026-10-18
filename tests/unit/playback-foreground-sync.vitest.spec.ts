import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { usePlaybackForegroundSync } from '@/hooks/audio/usePlaybackForegroundSync';

const mocks = vi.hoisted(() => ({ postCursor: vi.fn() }));
vi.mock('@/lib/client/api/tts', () => ({ postTtsPlaybackCursor: mocks.postCursor }));
vi.mock('@/contexts/AuthRateLimitContext', () => ({ useAuthRateLimit: () => ({ refresh: vi.fn() }) }));
let root: Root;
beforeEach(() => {
  mocks.postCursor.mockReset().mockResolvedValue({ workerOpId: null });
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root') as unknown as HTMLElement);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function fixture() {
  const input: Parameters<typeof usePlaybackForegroundSync>[0] = {
    audioRef: { current: null }, playbackCursorOrdinalRef: { current: 10 },
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
