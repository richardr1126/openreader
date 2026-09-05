import { describe, expect, test, vi } from 'vitest';
import { createCoalescedPlaybackRefresh, createPlaybackTimelineLoader, createPlaybackOperationSubscription } from '@/lib/client/tts/playback-refresh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('playback read-model delivery under network delay', () => {
  test('follows refill operations once and ignores late events after replacement or pause', () => {
    const callbacks = new Map<string, (snapshot: string) => void>();
    const close = vi.fn();
    const subscribe = vi.fn((id: string, onSnapshot: (snapshot: string) => void) => {
      callbacks.set(id, onSnapshot);
      return close;
    });
    const onSnapshot = vi.fn();
    const events = createPlaybackOperationSubscription({ subscribe, onSnapshot });
    events.update('first');
    events.update('first');
    callbacks.get('first')!('initial timing');
    events.update('refill');
    callbacks.get('first')!('stale model download');
    callbacks.get('refill')!('new exact timing');
    events.stop();
    callbacks.get('refill')!('late after pause');
    events.update('after-stop');
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(onSnapshot.mock.calls.flat()).toEqual(['initial timing', 'new exact timing']);
  });

  test('shares slow timeline reads and fetches exact timing on the next refresh', async () => {
    const slow = deferred<string>();
    const session = { timelineUrl: '/timeline' };
    const load = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue('exact');
    const apply = vi.fn();
    const loader = createPlaybackTimelineLoader({ load, apply, getRunId: () => 1, getSession: () => session });
    const first = loader.refresh('/timeline');
    for (let i = 0; i < 20; i++) expect(loader.refresh('/timeline')).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    slow.resolve('proportional');
    await first;
    await loader.refresh('/timeline');
    expect(apply.mock.calls.map(([value]) => value)).toEqual(['proportional', 'exact']);
  });

  test('cannot overwrite a new run with a late response, even if fetch ignores abort', async () => {
    const slow = deferred<string>();
    let runId = 1;
    const session = { timelineUrl: '/timeline' };
    const load = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue('new-exact');
    const apply = vi.fn();
    const loader = createPlaybackTimelineLoader({ load, apply, getRunId: () => runId, getSession: () => session });
    const old = loader.refresh('/timeline');
    runId = 2;
    await loader.refresh('/timeline');
    expect(load.mock.calls[0][1].aborted).toBe(true);
    slow.resolve('old-proportional');
    await old;
    expect(apply.mock.calls.map(([value]) => value)).toEqual(['new-exact']);
  });

  test('reset prevents pending reads from restoring a cleared timeline', async () => {
    const slow = deferred<string>();
    const session = { timelineUrl: '/timeline' };
    const apply = vi.fn();
    const loader = createPlaybackTimelineLoader({
      load: () => slow.promise, apply, getRunId: () => 1, getSession: () => session,
    });
    const read = loader.refresh('/timeline');
    loader.reset();
    slow.resolve('stale');
    await read;
    expect(apply).not.toHaveBeenCalled();
  });

  test('does not reuse a request whose foreground subscription has already aborted', async () => {
    const slow = deferred<string>();
    const session = { timelineUrl: '/timeline' };
    const load = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue('resumed');
    const apply = vi.fn();
    const loader = createPlaybackTimelineLoader({ load, apply, getRunId: () => 1, getSession: () => session });
    const controller = new AbortController();
    const old = loader.refresh('/timeline', controller.signal);
    controller.abort();
    await loader.refresh('/timeline');
    slow.resolve('aborted');
    await old;
    expect(apply.mock.calls.map(([value]) => value)).toEqual(['resumed']);
  });

  test('coalesces SSE bursts but preserves a trailing exact-timing refresh', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const refresh = createCoalescedPlaybackRefresh(load);
    refresh.request();
    for (let i = 0; i < 20; i++) refresh.request();
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    second.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(load).toHaveBeenCalledTimes(2);
    refresh.stop();
  });

  test('stopping aborts the active refresh and discards queued events', async () => {
    const slow = deferred<void>();
    const load = vi.fn(() => slow.promise);
    const refresh = createCoalescedPlaybackRefresh(load);
    refresh.request();
    refresh.request();
    refresh.stop();
    expect((load.mock.calls[0] as unknown as [AbortSignal])[0].aborted).toBe(true);
    slow.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    refresh.request();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
