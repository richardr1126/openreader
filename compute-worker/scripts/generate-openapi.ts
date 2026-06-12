import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createComputeWorkerApp } from '../src/runtime';

process.env.COMPUTE_WORKER_TOKEN ||= 'openapi-generation-token';
process.env.NATS_URL ||= 'nats://127.0.0.1:4222';

const outputPath = resolve(process.cwd(), 'openapi.json');
const runtime = await createComputeWorkerApp({
  workerToken: process.env.COMPUTE_WORKER_TOKEN,
  disableWorkers: true,
});

try {
  await runtime.app.ready();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(runtime.app.swagger(), null, 2)}\n`, 'utf8');
} finally {
  await runtime.close();
}
