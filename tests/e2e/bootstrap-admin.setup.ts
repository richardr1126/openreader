import { expect, test } from '@playwright/test';
import { closeChangelog } from './support/onboarding';

test('one-time first administrator changes the initial password', async ({ page }) => {
  await page.goto('/signin');
  await page.getByPlaceholder('me@example.com').fill('admin-e2e@example.test');
  await page.getByPlaceholder('Password', { exact: true }).fill('InitialAdminSecret#2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });

  const privacy = page.getByRole('dialog', { name: 'Privacy & Data Usage' });
  await privacy.getByRole('checkbox', { name: 'I have read and agree to the' }).check();
  await privacy.getByRole('button', { name: 'Continue' }).click();
  await closeChangelog(page);

  await page.goto('/app/settings?section=account');
  await expect(page.getByText('Finish administrator setup')).toBeVisible();
  await expect(page.getByText('admin-e2e@example.test').first()).toBeVisible();
  await expect(page.getByText('Email verification and address changes are unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Display name').fill('First Administrator');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Display name updated')).toBeVisible();
  // Editing the name collapses the auto-opened password editor; reopen it.
  await page.getByRole('button', { name: 'Activate', exact: true }).click();
  await page.getByLabel('Current password').fill('InitialAdminSecret#2026');
  await page.getByLabel('New password', { exact: true }).fill('TestAccount#2026');
  await page.getByLabel('Confirm new password').fill('TestAccount#2026');
  await page.getByRole('button', { name: 'Activate administrator access' }).click();
  await expect(page.getByRole('button', { name: 'Users', exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Activate administrator access' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Delete Account' }).click();
  await page.getByTestId('confirm-dialog-panel').getByRole('button', { name: 'Delete Account' }).click();
  await expect(page.getByText('The final administrator cannot be removed.')).toBeVisible();
});
