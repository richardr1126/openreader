import { Worker } from 'node:worker_threads';
import { getOnnxThreadsPerJob } from '../../infrastructure/config';
import { resolveWorkerEntry } from '../../worker-paths';

type InferenceOutput = { logits: { data: Float32Array }; pred_boxes: { data: Float32Array } };
let worker: Worker | null = null;
let nextId = 0;
const requests = new Map<number, { resolve(value: InferenceOutput): void; reject(error: Error): void }>();

function getWorker(modelPath: string): Worker {
  if (worker) return worker;
  const current = new Worker(resolveWorkerEntry('inference/pdf/layout-inference-worker'), {
    workerData: { modelPath, threads: getOnnxThreadsPerJob() },
  });
  worker = current;
  current.on('message', (message: { id: number; error?: string; logits?: Float32Array; boxes?: Float32Array }) => {
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve({
      logits: { data: message.logits ?? new Float32Array() },
      pred_boxes: { data: message.boxes ?? new Float32Array() },
    });
    if (requests.size === 0) current.unref();
  });
  const fail = (error: Error) => {
    if (worker !== current) return;
    worker = null;
    for (const request of requests.values()) request.reject(error);
    requests.clear();
    current.unref();
  };
  current.on('error', fail);
  current.on('exit', (code) => fail(new Error(`PDF inference thread exited (${code})`)));
  current.unref();
  return current;
}

export function runLayoutInference(modelPath: string, data: Float32Array, dims: readonly number[]): Promise<InferenceOutput> {
  const current = getWorker(modelPath);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    current.ref();
    // Preprocessing owns this dedicated float buffer; transfer rather than
    // retaining a second 800x800x3 copy while native inference runs.
    try {
      current.postMessage({ id, data, dims }, [data.buffer as ArrayBuffer]);
    } catch (error) {
      requests.delete(id);
      if (requests.size === 0) current.unref();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
