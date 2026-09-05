import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPlaybackRecovery } from '@/lib/client/tts/playback-recovery';

describe('same-session media recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  function fixture() {
    let current = true;
    let time = 20;
    const readyTarget = vi.fn<() => { ordinal: number; time: number } | null>(() => ({ ordinal: 12, time }));
    const reconnect = vi.fn();
    const onExhausted = vi.fn(() => { current = false; });
    const recovery = createPlaybackRecovery({
      isCurrent: () => current, currentTime: () => time, readyTarget, reconnect, onExhausted,
    });
    return { recovery, readyTarget, reconnect, onExhausted,
      setCurrent: (value: boolean) => { current = value; }, setTime: (value: number) => { time = value; } };
  }
  test('does nothing while the media clock advances', () => {
    const f = fixture();
    for (let i = 1; i <= 30; i++) { f.setTime(20 + i); vi.advanceTimersByTime(1_000); }
    expect(f.readyTarget).not.toHaveBeenCalled();
    expect(f.reconnect).not.toHaveBeenCalled();
  });
  test('waits for generated runway, then reconnects at the preserved cursor', () => {
    const f = fixture();
    f.readyTarget.mockReturnValue(null);
    vi.advanceTimersByTime(20_000);
    expect(f.reconnect).not.toHaveBeenCalled();
    f.readyTarget.mockReturnValue({ ordinal: 12, time: 20 });
    vi.advanceTimersByTime(1_000);
    expect(f.reconnect).toHaveBeenCalledExactlyOnceWith({ ordinal: 12, time: 20 });
  });
  test('bounds reconnects without progress and supports a deliberate later resume', () => {
    const f = fixture();
    vi.advanceTimersByTime(30_000);
    expect(f.reconnect).toHaveBeenCalledTimes(2);
    expect(f.onExhausted).toHaveBeenCalledTimes(1);
    f.setCurrent(true);
    vi.advanceTimersByTime(5_000);
    expect(f.reconnect).toHaveBeenCalledTimes(3);
  });
  test('pause and teardown prevent recovery; real progress resets its budget', () => {
    const f = fixture();
    vi.advanceTimersByTime(5_000);
    f.setTime(22);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(5_000);
    expect(f.reconnect).toHaveBeenCalledTimes(2);
    expect(f.onExhausted).not.toHaveBeenCalled();
    f.setCurrent(false);
    vi.advanceTimersByTime(30_000);
    expect(f.reconnect).toHaveBeenCalledTimes(2);
    f.recovery.stop();
    f.setCurrent(true);
    vi.advanceTimersByTime(30_000);
    f.recovery.check();
    expect(f.reconnect).toHaveBeenCalledTimes(2);
  });
});
