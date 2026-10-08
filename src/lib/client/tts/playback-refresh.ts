/**
 * Coalesce an event burst into one active read and one trailing read, never a
 * queue per event. A minimum interval prevents a fast SSE producer from making
 * whole-timeline JSON parsing a continuous main-thread task.
 */
export function createCoalescedPlaybackRefresh(
  refresh: (signal: AbortSignal) => Promise<unknown>,
  options?: { minIntervalMs?: number },
) {
  const controller = new AbortController();
  const minIntervalMs = Math.max(0, Math.floor(options?.minIntervalMs ?? 0));
  let running = false;
  let activeRead: AbortController | null = null;
  let pending = false;
  let lastStartedAt: number | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  const waitForCadence = (): Promise<void> | null => {
    const delayMs = lastStartedAt === null
      ? 0
      : Math.max(0, minIntervalMs - (Date.now() - lastStartedAt));
    if (delayMs === 0 || controller.signal.aborted) return null;
    return new Promise<void>((resolve) => {
      const finish = () => {
        if (waitTimer) clearTimeout(waitTimer);
        waitTimer = null;
        controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      waitTimer = setTimeout(finish, delayMs);
      controller.signal.addEventListener('abort', finish, { once: true });
    });
  };
  const request = (options?: { supersede?: boolean }) => {
    if (controller.signal.aborted) return;
    pending = true;
    if (options?.supersede) activeRead?.abort();
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (pending && !controller.signal.aborted) {
          pending = false;
          const cadenceWait = waitForCadence();
          if (cadenceWait) await cadenceWait;
          if (controller.signal.aborted) break;
          lastStartedAt = Date.now();
          activeRead = new AbortController();
          await refresh(AbortSignal.any([controller.signal, activeRead.signal])).catch(() => undefined);
          activeRead = null;
        }
      } finally {
        running = false;
      }
    })();
  };
  return {
    request,
    stop: () => {
      pending = false;
      controller.abort();
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = null;
    },
  };
}

/** Share in-flight timeline reads and prevent a late response from reviving an old playback run. */
export function createPlaybackTimelineLoader<T>(input: {
  load: (url: string, signal: AbortSignal) => Promise<T>;
  getRunId: () => number;
  getSession: () => { timelineUrl: string } | null;
  apply: (timeline: T) => void;
}) {
  type Read = {
    url: string;
    runId: number;
    session: ReturnType<typeof input.getSession>;
    controller: AbortController;
    signal: AbortSignal;
    scopeSignal?: AbortSignal;
    promise?: Promise<T>;
  };
  // Cursor-window and overview reads have different priorities and may overlap.
  // Sharing/teardown remains scoped to one run/session for both profiles.
  const active = new Map<string, Read>();
  const waitForRead = (promise: Promise<T>, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(() => resolve(), () => resolve()).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  };
  const reset = () => {
    for (const read of active.values()) read.controller.abort();
    active.clear();
  };
  const refresh = (url: string, signal?: AbortSignal): Promise<T> => {
    const runId = input.getRunId();
    const session = input.getSession();
    for (const [key, read] of active) {
      if (read.runId !== runId || read.session !== session
        || (url !== session?.timelineUrl && key !== session?.timelineUrl && key !== url)) {
        read.controller.abort();
        active.delete(key);
      }
    }
    const current = active.get(url);
    if (current && !current.signal.aborted && current.promise) {
      if (current.scopeSignal === signal || (current.scopeSignal !== undefined && signal === undefined)) {
        return current.promise;
      }
      if (current.scopeSignal === undefined && signal !== undefined) {
        // Do not abort a startup/timing-heal read that another caller awaits.
        // The foreground subscriber still gets one exact trailing read, and
        // its own stop signal can cancel the wait before that read starts.
        return waitForRead(current.promise, signal).then(() => refresh(url, signal));
      }
    }
    current?.controller.abort();
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([
      controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : []),
    ]);
    const read: Read = { url, runId, session, controller, signal: combinedSignal, scopeSignal: signal };
    active.set(url, read);
    read.promise = (async () => {
      try {
        const timeline = await input.load(url, combinedSignal);
        if (active.get(url) === read && !combinedSignal.aborted
          && input.getRunId() === runId && input.getSession() === session
          && session?.timelineUrl === url.split('?')[0]) input.apply(timeline);
        return timeline;
      } finally {
        if (active.get(url) === read) active.delete(url);
      }
    })();
    return read.promise;
  };
  return { refresh, reset };
}
/** Retarget operation-scoped SSE on the existing cursor heartbeat, without polling. */
export function createPlaybackOperationSubscription<T>(input: {
  subscribe: (operationId: string, onSnapshot: (snapshot: T) => void) => () => void;
  onSnapshot: (snapshot: T) => void;
}) {
  let current: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  return {
    update(operationId: string | null) {
      if (stopped || current === operationId) return;
      unsubscribe?.();
      unsubscribe = null;
      current = operationId;
      if (operationId) {
        unsubscribe = input.subscribe(operationId, (snapshot) => {
          if (!stopped && current === operationId) input.onSnapshot(snapshot);
        });
      }
    },
    stop() { stopped = true; unsubscribe?.(); unsubscribe = null; },
  };
}
