import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const bootstrapDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveEmbeddedWorkerLaunch() {
  const candidateDirs = [
    path.resolve(bootstrapDir, '..', 'embedded-compute-worker'),
    path.resolve(bootstrapDir, '..', 'compute-worker'),
    path.join(process.cwd(), 'embedded-compute-worker'),
    path.join(process.cwd(), 'packages', 'compute-worker'),
    path.join(process.cwd(), 'compute-worker'),
  ];

  for (const workerDir of candidateDirs) {
    if (!fs.existsSync(path.join(workerDir, 'src', 'server.ts'))) continue;
    return {
      cmd: process.execPath,
      args: ['--import', 'tsx', 'src/server.ts'],
      cwd: workerDir,
    };
  }

  throw new Error(
    'Could not find an embedded compute worker runtime. '
    + 'Include embedded-compute-worker/src/server.ts in the runtime image or keep packages/compute-worker available locally.',
  );
}
