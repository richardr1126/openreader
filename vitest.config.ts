import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

if (!process.env.AUTH_SECRET?.trim()) {
  process.env.AUTH_SECRET = 'vitest-auth-secret';
}

if (!/^https?:\/\//.test(process.env.BASE_URL ?? '')) {
  process.env.BASE_URL = 'http://localhost:3003';
}

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
          setupFiles: ['tests/unit/setup-env.ts'],
        },
      },
      {
        test: {
          name: 'compute-worker',
          environment: 'node',
          include: ['compute-worker/tests/{unit,api,compute}/**/*.test.ts'],
          setupFiles: ['compute-worker/tests/setup-env.ts'],
        },
      },
    ],
  },
});
