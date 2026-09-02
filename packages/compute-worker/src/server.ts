// Official ONNX Runtime builds enable Microsoft telemetry by default. Set the
// native opt-out before importing the worker graph so ONNX never initializes
// its uploader or persistent device identifier.
process.env.ORT_DISABLE_TELEMETRY = '1';

void import('./api/app').then(({ startComputeWorkerFromEnv }) => (
  startComputeWorkerFromEnv()
)).catch((error) => {
  console.error('[compute-worker] fatal startup error', error);
  process.exit(1);
});
