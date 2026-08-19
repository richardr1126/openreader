import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

const playbackTest = /playback-controls\.spec\.ts/;
const coreProjects = ['chromium', 'firefox', 'webkit'];
const includePlaybackProjects = !process.env.CI;

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
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: playbackTest,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testIgnore: playbackTest,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testIgnore: playbackTest,
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
          {
            name: 'playback-firefox',
            testMatch: playbackTest,
            dependencies: coreProjects,
            use: { ...devices['Desktop Firefox'] },
          },
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
