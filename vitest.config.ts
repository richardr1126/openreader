import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolveDevelopmentFfmpeg } from './packages/bootstrap/src/embedded-worker.mjs';

if (!process.env.AUTH_SECRET?.trim()) {
  process.env.AUTH_SECRET = 'vitest-auth-secret';
}

if (!/^https?:\/\//.test(process.env.BASE_URL ?? '')) {
  process.env.BASE_URL = 'http://localhost:3003';
}

// Tests spawn the same development ffmpeg that `pnpm dev` and `pnpm start` use.
if (!process.env.FFMPEG_BIN?.trim()) {
  const developmentFfmpeg = resolveDevelopmentFfmpeg(fileURLToPath(new URL('.', import.meta.url)));
  if (developmentFfmpeg) process.env.FFMPEG_BIN = developmentFfmpeg;
}

// These files write the shared admin_providers table, whose emptiness decides
// whether the seed's env fallback runs. In parallel workers one file's rows
// leak into another's assertions, so they run one at a time after the rest.
const providerTableFiles = [
  'tests/unit/runtime-seed-json.vitest.spec.ts',
  'tests/unit/admin-providers-validation.vitest.spec.ts',
  'tests/unit/tts-credential-broker-route.vitest.spec.ts',
];

const srcDir = fileURLToPath(new URL('./src/', import.meta.url));
const alias = [
  { find: /^@\//, replacement: `${srcDir}` },
  { find: '@', replacement: srcDir },
];

export default defineConfig({
  resolve: {
    alias,
  },
  test: {
    alias,
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    projects: [
      {
        resolve: {
          alias,
        },
        test: {
          name: 'openreader',
          environment: 'node',
          include: ['tests/unit/**/*.vitest.spec.ts'],
          exclude: providerTableFiles,
          setupFiles: ['tests/unit/setup-env.ts'],
        },
      },
      {
        resolve: {
          alias,
        },
        test: {
          name: 'openreader-provider-table',
          environment: 'node',
          include: providerTableFiles,
          setupFiles: ['tests/unit/setup-env.ts'],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        resolve: {
          alias,
        },
        test: {
          name: 'compute-worker',
          environment: 'node',
          alias,
          include: ['packages/compute-worker/tests/{unit,api,compute}/**/*.test.ts'],
          setupFiles: ['packages/compute-worker/tests/setup-env.ts'],
        },
      },
    ],
  },
});
