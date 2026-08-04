import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

export default defineConfig({
  testDir: './tests/e2e',
  tsconfig: './tsconfig.json',
  timeout: 30 * 1000,
  outputDir: './tests/results',
  fullyParallel: true,
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
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
