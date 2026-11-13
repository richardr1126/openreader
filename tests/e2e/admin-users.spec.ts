import { expect, test } from '@playwright/test';
import { declineOptionalCookies } from './support/onboarding';

const password = 'TestAccount#2026';

async function signUp(page: import('@playwright/test').Page, name: string, email: string) {
  await page.goto('/signup');
  await declineOptionalCookies(page);
  await page.getByRole('textbox', { name: 'Display name' }).fill(name);
  await page.getByPlaceholder('me@example.com').fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByPlaceholder('Confirm Password').fill(password);
  await page.getByRole('button', { name: /^(Sign up|Request access)$/ }).click();
}

test('admin approves a pending user and inspects the user directory', async ({ browser, page }, testInfo) => {
  test.setTimeout(90_000);
  const adminEmail = 'admin-e2e@example.test';
  const readerEmail = `reader-e2e-${testInfo.project.name}@example.test`;
  const readerName = `Reader ${testInfo.project.name}`;
  await page.goto('/signin');
  await declineOptionalCookies(page);
  await page.getByPlaceholder('me@example.com').fill(adminEmail);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });
  // The URL changes before the sign-in navigation settles; WebKit lets its end interrupt a goto.
  await expect(page.getByText('Drop your file(s) here, or click to select', { exact: true })).toBeVisible();
  const privacy = page.getByRole('dialog', { name: 'Privacy & Data Usage' });
  if (await privacy.isVisible()) {
    await privacy.getByRole('checkbox', { name: 'I have read and agree to the' }).check();
    await privacy.getByRole('button', { name: 'Continue' }).click();
  }

  await page.goto('/app/settings?section=users');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  // Parallel guest journeys can push the oldest account past the first page.
  const userSearch = page.getByRole('searchbox', { name: 'Search users' });
  await userSearch.fill(adminEmail);
  // The directory lists names; an address stays hidden until asked for.
  await page.getByRole('button', { name: /First Administrator/ }).click();
  await expect(page.getByText(adminEmail)).toHaveCount(0);
  await page.getByRole('button', { name: 'Show email', exact: true }).click();
  await expect(page.getByText(adminEmail)).toBeVisible();
  await userSearch.clear();
  await page.getByRole('radio', { name: 'Anon', exact: true }).click();
  await expect(page.getByText('Anonymous', { exact: true }).first()).toBeVisible();
  await page.getByRole('radio', { name: 'All', exact: true }).click();

  await page.getByRole('button', { name: 'Providers', exact: true }).first().click();
  await expect(page.getByRole('switch', { name: 'Offer Kokoro-82M to users' })).toBeVisible();
  await page.getByRole('button', { name: 'Add provider' }).click();
  await page.getByRole('dialog', { name: 'Add provider' })
    .getByRole('button', { name: /^OpenAI-compatible server/ }).click();
  const providerDialog = page.getByRole('dialog', { name: 'Add OpenAI-compatible server' });
  await providerDialog.getByRole('textbox', { name: 'Base URL' }).fill('http://127.0.0.1:9/v1');
  await providerDialog.getByRole('button', { name: 'Check', exact: true }).click();
  const providerChecks = providerDialog.getByRole('list', { name: 'Provider check results' });
  await expect(providerChecks.getByRole('listitem').filter({ hasText: 'Connection' })).toContainText('Could not reach 127.0.0.1:9');
  await providerDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(providerDialog).toBeHidden();

  await page.getByRole('button', { name: 'Maintenance', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Maintenance', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scheduled tasks', exact: true })).toBeVisible();
  const systemChecks = page.getByRole('list', { name: 'System check results' });
  await expect(systemChecks.getByText('Compute worker')).toBeVisible();
  await expect(systemChecks.getByText('Object storage')).toBeVisible();
  await expect(systemChecks.getByText('Playback signing secret')).toBeVisible();
  await expect(systemChecks.getByText('Address you opened')).toBeVisible();

  await page.getByRole('button', { name: 'Access', exact: true }).first().click();
  await page.getByRole('switch', { name: 'New accounts per IP', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Accounts per period', exact: true })).toHaveValue('5');
  await expect(page.getByRole('spinbutton', { name: 'Account period', exact: true })).toHaveValue('30');
  await page.getByRole('switch', { name: 'New guests per IP', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Guests per idle period', exact: true })).toHaveValue('10');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Guests per idle period', exact: true })).toHaveCount(0);
  // Account email saves on its own, and only once edited.
  await expect(page.getByRole('heading', { name: 'Account email', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Limits', exact: true }).first().click();
  await page.getByRole('switch', { name: 'Storage per account', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Account storage cap', exact: true })).toHaveValue('10240');
  await page.getByText('New documents', { exact: true }).click();
  await page.getByRole('switch', { name: 'Limit daily files', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Guest daily files', exact: true })).toHaveValue('10');
  await expect(page.getByRole('spinbutton', { name: 'Account daily files', exact: true })).toHaveValue('100');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('button', { name: 'Features', exact: true }).first().click();
  // The Gutenberg catalog also saves on its own, and only once edited.
  await expect(page.getByRole('heading', { name: 'Project Gutenberg', exact: true })).toBeVisible();
  const catalogSave = page.getByRole('button', { name: 'Save', exact: true });
  await expect(catalogSave).toBeDisabled();
  const catalogSwitch = page.getByRole('switch', { name: 'Enable the Project Gutenberg catalog' });
  await catalogSwitch.click();
  await expect(catalogSave).toBeEnabled();
  await catalogSwitch.click();
  await expect(catalogSave).toBeDisabled();
  // A saved setting resets to its seeded value from its own row. The setting is
  // instance-wide and both browsers share one server, so only one project changes it.
  if (testInfo.project.name === 'chromium') {
    await page.getByRole('button', { name: 'Providers', exact: true }).first().click();
    const retries = page.getByRole('spinbutton', { name: 'Retry attempts', exact: true });
    const seededRetries = await retries.inputValue();
    await retries.fill(String(Number(seededRetries) + 1));
    await page.getByRole('button', { name: /^Save \(1\)$/ }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Generation settings saved$/ })).toBeVisible();
    await page.locator('div.justify-between').filter({ has: retries }).getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page.getByText('Reset to env default')).toBeVisible();
    await expect(retries).toHaveValue(seededRetries);
  }
  await page.getByRole('button', { name: 'Access', exact: true }).first().click();
  await page.getByRole('radio', { name: 'Approve', exact: true }).click();
  const savePolicy = page.getByRole('button', { name: /^Save \(1\)$/ });
  if (await savePolicy.isVisible()) {
    await savePolicy.click();
    await expect(page.getByRole('status').filter({ hasText: /^Access settings saved$/ })).toBeVisible();
  }

  const reader = await browser.newPage();
  try {
    await signUp(reader, readerName, readerEmail);
    await expect(reader.getByRole('heading', { name: 'Request received' })).toBeVisible();
    await reader.getByRole('link', { name: 'Return to sign in' }).click();
    await reader.getByPlaceholder('me@example.com').fill(readerEmail);
    await reader.getByPlaceholder('Password', { exact: true }).fill(password);
    await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(reader.getByText(/waiting for administrator approval/i)).toBeVisible();

    await page.goto('/app/settings?section=users');
    await page.getByRole('searchbox', { name: 'Search users' }).fill(readerEmail);
    await expect(page.getByRole('checkbox', { name: `Select ${readerName}`, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).last().click();
    await expect(page.getByText('User updated')).toBeVisible();

    await reader.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(reader).toHaveURL(/\/app$/, { timeout: 30_000 });

    // Account deletion is one durable worker operation, observed through SSE.
    await page.getByRole('checkbox', { name: `Select ${readerName}`, exact: true }).check();
    await page.getByRole('button', { name: 'Delete (1)', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete selected users?' }).getByRole('button', { name: 'Delete users', exact: true }).click();
    await expect(page.getByText('Deleted 1 account(s); 0 failed', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('checkbox', { name: `Select ${readerName}`, exact: true })).toHaveCount(0);
  } finally {
    await reader.close();
  }
});
