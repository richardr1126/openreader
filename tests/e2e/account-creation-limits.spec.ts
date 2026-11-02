import { expect, test } from '@playwright/test';

test('a capped visitor reaches sign-in without retrying guest creation', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/auth/sign-in/anonymous', async (route) => {
    attempts++;
    await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({
      code: 'ACCOUNT_CREATION_LIMITED', message: 'Too many new guests from this network. Please sign in or create an account.',
    }) });
  });
  await page.goto('/app');
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign up', exact: true })).toBeVisible();
  expect(attempts).toBe(1);
});
