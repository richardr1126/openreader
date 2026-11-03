import { expect, test } from '@playwright/test';
import { declineOptionalCookies } from './support/onboarding';

test('a download link asks for sign-in, then offers another account when this one has no access', async ({ page }) => {
  await page.goto('/audiobooks/0123456789abcdef/abcdef12');
  await declineOptionalCookies(page);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();

  const signIn = async () => {
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await page.getByPlaceholder('me@example.com').fill('admin-e2e@example.test');
    await page.getByPlaceholder('Password', { exact: true }).fill('TestAccount#2026');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'You need access', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/audiobooks\/0123456789abcdef\/abcdef12$/);
  };
  await signIn();
  await expect(page.getByText('First Administrator can’t open this audiobook.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Switch account', exact: true }).click();
  await signIn();
});
