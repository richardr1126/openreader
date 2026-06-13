import { startComputeWorkerFromEnv } from './api/app';

void startComputeWorkerFromEnv().catch((error) => {
  console.error('[compute-worker] fatal startup error', error);
  process.exit(1);
});
