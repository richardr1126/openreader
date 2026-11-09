// The thread side of inference-thread.ts. `load` runs once and reports
// readiness; each call then runs `handle(payload, loaded)` one at a time, in
// the order received, and replies with its result or error message.
import { parentPort } from 'node:worker_threads';

const describe = (error) => (error instanceof Error ? error.message : String(error));

export function serveInferenceThread(load, handle) {
  const loaded = Promise.resolve().then(load);
  loaded.then(
    () => parentPort.postMessage({ ready: true }),
    (error) => parentPort.postMessage({ ready: false, error: describe(error) }),
  );
  let pending = Promise.resolve();
  parentPort.on('message', ({ id, payload }) => {
    pending = pending.then(async () => {
      try {
        const result = await handle(payload, await loaded);
        parentPort.postMessage({ id, result });
      } catch (error) {
        parentPort.postMessage({ id, error: describe(error) });
      }
    });
  });
}
