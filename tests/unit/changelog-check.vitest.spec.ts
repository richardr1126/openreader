import { describe, expect, test } from 'vitest';

import { scheduleChangelogCheck } from '../../src/lib/client/changelog-check';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('changelog check scheduling', () => {
  test('cancels throwaway mount and runs exactly once on remount', async () => {
    const completedRef = { current: null as string | null };
    const inFlightRef = { current: null as string | null };
    let apiCalls = 0;
    let openCalls = 0;

    const args = {
      isSessionPending: false,
      sessionUserId: 'u1',
      appVersion: '3.3.0',
      completedRef,
      inFlightRef,
      postCheck: async () => {
        apiCalls += 1;
        return {
          shouldOpen: true,
          currentVersion: '3.3.0',
          lastSeenVersion: null,
        };
      },
      onShouldOpen: () => {
        openCalls += 1;
      },
      delayMs: 40,
      retryDelayMs: 1,
    } as const;

    const cleanupThrowaway = scheduleChangelogCheck(args);
    cleanupThrowaway();

    const cleanupReal = scheduleChangelogCheck(args);
    await wait(120);
    cleanupReal();

    expect(apiCalls).toBe(1);
    expect(openCalls).toBe(1);
    expect(completedRef.current).toBe('u1:3.3.0');
    expect(inFlightRef.current).toBeNull();
  });

  test('does not run while session is pending', async () => {
    const completedRef = { current: null as string | null };
    const inFlightRef = { current: null as string | null };
    let apiCalls = 0;

    const cleanup = scheduleChangelogCheck({
      isSessionPending: true,
      sessionUserId: null,
      appVersion: '3.3.0',
      completedRef,
      inFlightRef,
      postCheck: async () => {
        apiCalls += 1;
        return {
          shouldOpen: true,
          currentVersion: '3.3.0',
          lastSeenVersion: null,
        };
      },
      onShouldOpen: () => undefined,
      delayMs: 20,
    });

    await wait(80);
    cleanup();
    expect(apiCalls).toBe(0);
    expect(completedRef.current).toBeNull();
    expect(inFlightRef.current).toBeNull();
  });
});
