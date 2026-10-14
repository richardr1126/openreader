import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const bootstrapDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Production runs the worker's built JavaScript (`pnpm build` or the image's
// deployed bundle). `fromSource` is only for `pnpm dev`, which runs the
// TypeScript sources through tsx from the monorepo checkout.
export function resolveEmbeddedWorkerLaunch({ fromSource = false } = {}) {
  const entry = fromSource ? path.join('src', 'server.ts') : path.join('dist', 'server.js');
  const candidateDirs = [
    path.resolve(bootstrapDir, '..', 'embedded-compute-worker'),
    path.resolve(bootstrapDir, '..', 'compute-worker'),
    path.join(process.cwd(), 'embedded-compute-worker'),
    path.join(process.cwd(), 'packages', 'compute-worker'),
    path.join(process.cwd(), 'compute-worker'),
  ];

  for (const workerDir of candidateDirs) {
    if (!fs.existsSync(path.join(workerDir, entry))) continue;
    return {
      cmd: process.execPath,
      args: fromSource ? ['--import', 'tsx', entry] : ['--enable-source-maps', entry],
      cwd: workerDir,
    };
  }

  throw new Error(
    `Could not find the embedded compute worker entry ${entry}. `
    + (fromSource
      ? 'Keep packages/compute-worker available locally.'
      : 'Run `pnpm build` (or `pnpm compute:build`) first, or include embedded-compute-worker/dist in the runtime image.'),
  );
}
