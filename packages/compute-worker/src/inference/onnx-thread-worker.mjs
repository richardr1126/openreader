// ONNX Runtime's Node backend runs native inference synchronously, even though
// its public API returns a Promise. One model session lives on this thread so
// HTTP, audio streaming, SSE and NATS stay responsive while a model runs.
import { parentPort, workerData } from 'node:worker_threads';
import { InferenceSession, Tensor } from 'onnxruntime-node';

const describe = (error) => (error instanceof Error ? error.message : String(error));

const session = InferenceSession.create(workerData.modelPath, {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
  intraOpNumThreads: workerData.threads,
  interOpNumThreads: 1,
  executionMode: 'sequential',
});
session.then(
  () => parentPort.postMessage({ ready: true }),
  (error) => parentPort.postMessage({ ready: false, error: describe(error) }),
);

let pending = Promise.resolve();
parentPort.on('message', ({ id, feeds }) => {
  pending = pending.then(async () => {
    try {
      const inputs = {};
      for (const [name, feed] of Object.entries(feeds)) inputs[name] = new Tensor(feed.type, feed.data, feed.dims);
      const output = await (await session).run(inputs);
      const outputs = {};
      for (const [name, tensor] of Object.entries(output)) outputs[name] = tensor.data;
      parentPort.postMessage({ id, outputs });
    } catch (error) {
      parentPort.postMessage({ id, error: describe(error) });
    }
  });
});
