import { Worker } from 'node:worker_threads';
import { getOnnxThreadsPerJob } from '../infrastructure/config';
import { resolveWorkerEntry } from '../worker-paths';

export interface OnnxFeed {
  type: 'float32' | 'int64';
  data: Float32Array | BigInt64Array;
  dims: readonly number[];
}

export type OnnxOutputs = Record<string, Float32Array | BigInt64Array | undefined>;

export interface OnnxThreadSession {
  /** Runs once the previous run finishes. Takes ownership of the feeds' buffers. */
  run(feeds: Record<string, OnnxFeed>): Promise<OnnxOutputs>;
  /** Ends the thread and frees the model; a later run loads it again. */
  release(): Promise<void>;
}

type ThreadMessage =
  | { ready: true }
  | { ready: false; error: string }
  | { id: number; outputs: OnnxOutputs }
  | { id: number; error: string };

interface Thread {
  worker: Worker;
  ready: Promise<void>;
  requests: Map<number, { resolve(value: OnnxOutputs): void; reject(error: Error): void }>;
}

/**
 * Loads `modelPath` on its own thread and resolves once the session is ready,
 * so a model that cannot load fails here rather than on its first run. A thread
 * that exits is replaced on the next run.
 */
export async function openOnnxThreadSession(modelPath: string): Promise<OnnxThreadSession> {
  let thread: Thread | null = null;
  let nextId = 0;

  const spawn = (): Thread => {
    const worker = new Worker(resolveWorkerEntry('inference/onnx-thread-worker'), {
      workerData: { modelPath, threads: getOnnxThreadsPerJob() },
    });
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
      if ('outputs' in message) request.resolve(message.outputs);
      else request.reject(new Error(message.error));
      if (requests.size === 0) worker.unref();
    });
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`ONNX inference thread exited (${code})`)));
    return current;
  };

  const ensureThread = (): Thread => (thread ??= spawn());
  await ensureThread().ready;

  return {
    async run(feeds) {
      const current = ensureThread();
      await current.ready;
      const id = ++nextId;
      return new Promise<OnnxOutputs>((resolve, reject) => {
        current.requests.set(id, { resolve, reject });
        current.worker.ref();
        try {
          const transfer = [...new Set(Object.values(feeds).map((feed) => feed.data.buffer as ArrayBuffer))];
          current.worker.postMessage({ id, feeds }, transfer);
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
      const error = new Error('ONNX inference thread released');
      for (const request of current.requests.values()) request.reject(error);
      current.requests.clear();
      await current.worker.terminate();
    },
  };
}
