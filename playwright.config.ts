import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import 'dotenv/config';

const playbackTest = /playback-controls\.spec\.ts/;
const bootstrapSetup = /bootstrap-admin\.setup\.ts/;
const coreProjects = [
  'chromium',
  // 'firefox', // Temporarily disabled: Playwright Firefox hangs on macOS 27.
  'webkit',
];
const includePlaybackProjects = !process.env.CI;
const e2eRuntimeDir = resolve('tests/results/runtime');

export default defineConfig({
  testDir: './tests/e2e',
  tsconfig: './tsconfig.json',
  timeout: 30 * 1000,
  outputDir: './tests/results',
  fullyParallel: true,
  failOnFlakyTests: !!process.env.CI,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: '50%',
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3003',
    trace: 'retain-on-first-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm build && DISABLE_AUTH_RATE_LIMIT=true pnpm start',
    url: 'http://localhost:3003',
    reuseExistingServer: false,
    timeout: 120 * 1000,
    env: {
      // Playwright owns a disposable control-plane/data-plane stack. Keeping
      // its state under outputDir makes every invocation start without stale
      // SQL rows, object blobs, or terminal JetStream operations from a prior
      // run while leaving the developer's normal docstore untouched.
      SQLITE_DB_PATH: resolve(e2eRuntimeDir, 'sqlite3.db'),
      USE_EMBEDDED_WEED_MINI: 'true',
      WEED_MINI_DIR: resolve(e2eRuntimeDir, 'seaweedfs'),
      EMBEDDED_NATS_STORE_DIR: resolve(e2eRuntimeDir, 'nats'),
      S3_ACCESS_KEY_ID: 'openreader-e2e',
      S3_SECRET_ACCESS_KEY: 'openreader-e2e-secret',
      S3_BUCKET: 'openreader-e2e',
      S3_REGION: 'us-east-1',
      S3_INTERNAL_ENDPOINT: 'http://127.0.0.1:8333',
      S3_BROWSER_TRANSPORT: 'proxy',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PREFIX: 'openreader-e2e',
      RUN_V4_DECOMMISSION: 'false',
      // The browser is driven at localhost:3003 while CI sets BASE_URL to the
      // 127.0.0.1 origin; trust both so credential sign-in is not rejected as a
      // cross-origin request, independent of any developer .env.
      AUTH_TRUSTED_ORIGINS: 'http://localhost:3003,http://127.0.0.1:3003',
      BOOTSTRAP_ADMIN_EMAIL: 'admin-e2e@example.test',
      BOOTSTRAP_ADMIN_PASSWORD: 'InitialAdminSecret#2026',
    },
  },
  projects: [
    {
      name: 'bootstrap',
      testMatch: bootstrapSetup,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: [playbackTest, bootstrapSetup],
      dependencies: ['bootstrap'],
      use: { ...devices['Desktop Chrome'] },
    },
    // {
    //   name: 'firefox',
    //   testIgnore: playbackTest,
    //   use: { ...devices['Desktop Firefox'] },
    // },
    {
      name: 'webkit',
      testIgnore: [playbackTest, bootstrapSetup],
      dependencies: ['bootstrap'],
      use: { ...devices['Desktop Safari'] },
    },
    ...(includePlaybackProjects
      ? [
          {
            name: 'playback-chromium',
            testMatch: playbackTest,
            dependencies: coreProjects,
            use: { ...devices['Desktop Chrome'] },
          },
          // {
          //   name: 'playback-firefox',
          //   testMatch: playbackTest,
          //   dependencies: coreProjects,
          //   use: { ...devices['Desktop Firefox'] },
          // },
          {
            name: 'playback-webkit',
            testMatch: playbackTest,
            dependencies: coreProjects,
            use: { ...devices['Desktop Safari'] },
          },
        ]
      : []),
  ],
});
