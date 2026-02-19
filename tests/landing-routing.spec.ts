import { expect, test } from '@playwright/test';

import { setupTest, uploadAndDisplay } from './helpers';

const AUTH_ENABLED = Boolean(process.env.AUTH_SECRET && process.env.BASE_URL);

test.describe('Landing and app routing', () => {
  test('public landing renders without anonymous auth bootstrap call', async ({ page }) => {
    let anonymousSignInCalls = 0;

    await page.route('**/api/auth/**', async (route) => {
      if (route.request().url().includes('/sign-in/anonymous')) {
        anonymousSignInCalls += 1;
      }
      await route.continue();
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /your documents,\s*read aloud/i })).toBeVisible({
      timeout: 10000,
    });

    // Let in-flight requests settle before asserting no anonymous bootstrap happened.
    await page.waitForTimeout(500);
    expect(anonymousSignInCalls).toBe(0);
  });

  test('existing authenticated session visiting / redirects to /app', async ({ page }) => {
    test.skip(!AUTH_ENABLED);

    await page.goto('/app');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.fixed.inset-0.bg-base.z-50', { state: 'detached', timeout: 15000 }).catch(() => {});

    await page.goto('/');
    await expect(page).toHaveURL(/\/app$/);
  });

  test('documents back link returns to /app', async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
    await uploadAndDisplay(page, 'sample.pdf');

    await page.getByRole('link', { name: 'Documents' }).click();
    await expect(page).toHaveURL(/\/app$/);
  });

  test('protected app routes redirect to /signin when anonymous auth is disabled', async ({ page }) => {
    test.skip(!AUTH_ENABLED || process.env.USE_ANONYMOUS_AUTH_SESSIONS !== 'false');

    await page.goto('/app');
    await expect(page).toHaveURL(/\/signin$/);
  });
});
