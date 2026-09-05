/** Coalesce an event burst into one active read and one trailing read, never a queue per event. */
export function createCoalescedPlaybackRefresh(refresh: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  let running = false;
  let pending = false;
  const request = () => {
    if (controller.signal.aborted) return;
    pending = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (pending && !controller.signal.aborted) {
          pending = false;
          await refresh(controller.signal).catch(() => undefined);
        }
      } finally {
        running = false;
      }
    })();
  };
  return { request, stop: () => { pending = false; controller.abort(); } };
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
  let active: Read | null = null;
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
    active?.controller.abort();
    active = null;
  };
  const refresh = (url: string, signal?: AbortSignal): Promise<T> => {
    const runId = input.getRunId();
    const session = input.getSession();
    if (active?.url === url && active.runId === runId && active.session === session
      && !active.signal.aborted && active.promise) {
      if (active.scopeSignal === signal || (active.scopeSignal !== undefined && signal === undefined)) {
        return active.promise;
      }
      if (active.scopeSignal === undefined && signal !== undefined) {
        // Do not abort a startup/timing-heal read that another caller awaits.
        // The foreground subscriber still gets one exact trailing read, and
        // its own stop signal can cancel the wait before that read starts.
        return waitForRead(active.promise, signal).then(() => refresh(url, signal));
      }
    }
    reset();
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([
      controller.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : []),
    ]);
    const read: Read = { url, runId, session, controller, signal: combinedSignal, scopeSignal: signal };
    active = read;
    read.promise = (async () => {
      try {
        const timeline = await input.load(url, combinedSignal);
        if (active === read && !combinedSignal.aborted
          && input.getRunId() === runId && input.getSession() === session
          && session?.timelineUrl === url) input.apply(timeline);
        return timeline;
      } finally {
        if (active === read) active = null;
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
