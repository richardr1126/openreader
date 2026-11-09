// One ONNX model session on its own thread (see onnx-thread.ts).
import { workerData } from 'node:worker_threads';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { serveInferenceThread } from './serve-inference-thread.mjs';

serveInferenceThread(
  () => InferenceSession.create(workerData.modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: workerData.threads,
    interOpNumThreads: 1,
    executionMode: 'sequential',
  }),
  async (feeds, session) => {
    const inputs = {};
    for (const [name, feed] of Object.entries(feeds)) inputs[name] = new Tensor(feed.type, feed.data, feed.dims);
    const output = await session.run(inputs);
    const outputs = {};
    for (const [name, tensor] of Object.entries(output)) outputs[name] = tensor.data;
    return outputs;
  },
);
