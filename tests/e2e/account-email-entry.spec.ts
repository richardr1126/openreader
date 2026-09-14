import { expect, test } from '@playwright/test';

test('account email entry points stay public and respect the disabled default', async ({ page }) => {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Forgot password?', exact: true })).toHaveCount(0);

  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { name: 'Reset your password', exact: true })).toBeVisible();
  await expect(page.getByText('Password recovery by email is not enabled on this OpenReader instance.', { exact: true })).toBeVisible();

  await page.goto('/verify-email');
  await expect(page.getByRole('heading', { name: 'Link unavailable', exact: true })).toBeVisible();
  await expect(page.getByText('Account email actions are disabled on this OpenReader instance.', { exact: true })).toBeVisible();

  await page.goto('/reset-password');
  await expect(page.getByRole('heading', { name: 'Choose a new password', exact: true })).toBeVisible();
  await expect(page.getByText('This reset link is invalid or expired.', { exact: true })).toBeVisible();
});
