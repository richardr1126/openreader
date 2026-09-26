import { expect, test } from '@playwright/test';
import { declineOptionalCookies } from './support/onboarding';

const password = 'TestAccount#2026';

async function signUp(page: import('@playwright/test').Page, email: string) {
  await page.goto('/signup');
  await declineOptionalCookies(page);
  await page.getByPlaceholder('me@example.com').fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByPlaceholder('Confirm Password').fill(password);
  await page.getByRole('button', { name: /^(Sign up|Request access)$/ }).click();
}

test('admin approves a pending user and inspects the user directory', async ({ browser, page }, testInfo) => {
  test.setTimeout(90_000);
  const adminEmail = 'admin-e2e@example.test';
  const readerEmail = `reader-e2e-${testInfo.project.name}@example.test`;
  await page.goto('/signin');
  await declineOptionalCookies(page);
  await page.getByPlaceholder('me@example.com').fill(adminEmail);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
  const privacy = page.getByRole('dialog', { name: 'Privacy & Data Usage' });
  if (await privacy.isVisible()) {
    await privacy.getByRole('checkbox', { name: 'I have read and agree to the' }).check();
    await privacy.getByRole('button', { name: 'Continue' }).click();
  }

  await page.goto('/app/settings?section=users');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  await expect(page.getByText(adminEmail).first()).toBeVisible();
  await expect(page.getByText('Anonymous', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Instance', exact: true }).first().click();
  await page.getByRole('radio', { name: 'Approve', exact: true }).click();
  const savePolicy = page.getByRole('button', { name: /^Save \(1\)$/ });
  if (await savePolicy.isVisible()) {
    await savePolicy.click();
    await expect(page.getByText('Settings saved')).toBeVisible();
  }

  const reader = await browser.newPage();
  try {
    await signUp(reader, readerEmail);
    await expect(reader.getByRole('heading', { name: 'Request received' })).toBeVisible();
    await reader.getByRole('link', { name: 'Return to sign in' }).click();
    await reader.getByPlaceholder('me@example.com').fill(readerEmail);
    await reader.getByPlaceholder('Password', { exact: true }).fill(password);
    await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(reader.getByText(/waiting for administrator approval/i)).toBeVisible();

    await page.goto('/app/settings?section=users');
    await page.getByRole('searchbox', { name: 'Search users' }).fill(readerEmail);
    await expect(page.getByText(readerEmail).first()).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).last().click();
    await expect(page.getByText('User updated')).toBeVisible();

    await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(reader).toHaveURL(/\/app$/, { timeout: 30_000 });
  } finally {
    await reader.close();
  }
});
