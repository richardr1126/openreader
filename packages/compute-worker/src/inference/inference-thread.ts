import { Worker } from 'node:worker_threads';
import { resolveWorkerEntry } from '../worker-paths';

/**
 * A request/response channel to one inference thread (see
 * serve-inference-thread.mjs for the thread side). Native inference blocks the
 * thread that runs it, so models run here rather than on the worker's event
 * loop. A thread that exits is replaced on the next call.
 */
export interface InferenceThread {
  /** Resolves once a thread is running and has loaded what it needs, starting one if none is. */
  ready(): Promise<void>;
  /** Runs after the thread's earlier calls. Transferred buffers belong to the thread afterwards. */
  call<T>(payload: unknown, transfer?: readonly ArrayBuffer[]): Promise<T>;
  /** Ends the thread; a later call starts a new one. */
  release(): Promise<void>;
}

type ThreadMessage =
  | { ready: true }
  | { ready: false; error: string }
  | { id: number; result: unknown }
  | { id: number; error: string };

interface Thread {
  worker: Worker;
  ready: Promise<void>;
  requests: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>;
}

export function createInferenceThread(entry: string, workerData: () => unknown): InferenceThread {
  let thread: Thread | null = null;
  let nextId = 0;

  const spawn = (): Thread => {
    const worker = new Worker(resolveWorkerEntry(entry), { workerData: workerData() });
    const requests: Thread['requests'] = new Map();
    let settleReady!: { resolve(): void; reject(error: Error): void };
    const ready = new Promise<void>((resolve, reject) => { settleReady = { resolve, reject }; });
    // Callers that await it see the failure; a thread released before it loads must not leave an unhandled rejection.
    ready.catch(() => undefined);
    const current: Thread = { worker, ready, requests };
    const fail = (error: Error) => {
      if (thread === current) thread = null;
      settleReady.reject(error);
      for (const request of requests.values()) request.reject(error);
      requests.clear();
      void worker.terminate();
    };
    worker.on('message', (message: ThreadMessage) => {
      if ('ready' in message) {
        if (!message.ready) return fail(new Error(message.error));
        settleReady.resolve();
        // Loading holds the process open like any pending I/O; an idle loaded thread does not.
        if (requests.size === 0) worker.unref();
        return;
      }
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      if ('result' in message) request.resolve(message.result);
      else request.reject(new Error(message.error));
      if (requests.size === 0) worker.unref();
    });
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`Inference thread ${entry} exited (${code})`)));
    return current;
  };

  const ensureThread = (): Thread => (thread ??= spawn());

  return {
    ready: () => ensureThread().ready,
    async call<T>(payload: unknown, transfer: readonly ArrayBuffer[] = []) {
      const current = ensureThread();
      await current.ready;
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        current.requests.set(id, { resolve: resolve as (value: unknown) => void, reject });
        current.worker.ref();
        try {
          current.worker.postMessage({ id, payload }, [...new Set(transfer)]);
        } catch (error) {
          current.requests.delete(id);
          if (current.requests.size === 0) current.worker.unref();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    async release() {
      const current = thread;
      thread = null;
      if (!current) return;
      const error = new Error(`Inference thread ${entry} released`);
      for (const request of current.requests.values()) request.reject(error);
      current.requests.clear();
      await current.worker.terminate();
    },
  };
}
