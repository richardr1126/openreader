import { expect, test } from '@playwright/test';

test('a signed-out visit reaches sign-in without creating a guest, then opens the library', async ({ page }) => {
  let guestsStarted = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/auth/sign-in/anonymous')) guestsStarted++;
  });

  await page.goto('/app');
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(guestsStarted).toBe(0);

  await page.getByPlaceholder('me@example.com').fill('admin-e2e@example.test');
  await page.getByPlaceholder('Password', { exact: true }).fill('TestAccount#2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  expect(guestsStarted).toBe(0);
});

test('a stale session cookie is sent to sign-in', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'better-auth.session_token', value: 'stale', url: baseURL! }]);
  await page.goto('/pdf/0123456789abcdef');
  await expect(page).toHaveURL(/\/signin\?returnTo=%2Fpdf%2F0123456789abcdef$/);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});
