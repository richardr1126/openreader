// ONNX Runtime's Node backend runs native inference synchronously, even though
// its public API returns a Promise. Keep both session creation and inference
// off the HTTP/job/event loop. One warm session serves the bounded PDF jobs.
import { parentPort, workerData } from 'node:worker_threads';
import { InferenceSession, Tensor } from 'onnxruntime-node';

const session = InferenceSession.create(workerData.modelPath, {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
  intraOpNumThreads: workerData.threads,
  interOpNumThreads: 1,
  executionMode: 'sequential',
});

let pending = Promise.resolve();
parentPort.on('message', ({ id, data, dims }) => {
  pending = pending.then(async () => {
    try {
      const output = await (await session).run({ pixel_values: new Tensor('float32', data, dims) });
      const logits = output.logits?.data;
      const boxes = output.pred_boxes?.data;
      parentPort.postMessage({ id, logits, boxes });
    } catch (error) {
      parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
// Session initialization can fail before the first page arrives. The request
// path reports that failure; do not create an unhandled rejection meanwhile.
session.catch(() => undefined);
