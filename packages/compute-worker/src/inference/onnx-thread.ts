import { getOnnxThreadsPerJob } from '../infrastructure/config';
import { createInferenceThread } from './inference-thread';

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

/**
 * Loads `modelPath` on its own thread and resolves once the session is ready,
 * so a model that cannot load fails here rather than on its first run.
 */
export async function openOnnxThreadSession(modelPath: string): Promise<OnnxThreadSession> {
  const thread = createInferenceThread('inference/onnx-thread-worker',
    () => ({ modelPath, threads: getOnnxThreadsPerJob() }));
  await thread.ready();
  return {
    run: (feeds) => thread.call<OnnxOutputs>(feeds,
      Object.values(feeds).map((feed) => feed.data.buffer as ArrayBuffer)),
    release: () => thread.release(),
  };
}
