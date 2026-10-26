import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';

test('Fish Audio keeps its explicit free model and custom voice reference', async ({ page, playwright }, testInfo) => {
  await enterAnonymousLibrary(page);
  const admin = await playwright.request.newContext({ baseURL: 'http://localhost:3003' });
  const signIn = await admin.post('/api/auth/sign-in/email', {
    headers: { Origin: 'http://localhost:3003' },
    data: { email: 'admin-e2e@example.test', password: 'TestAccount#2026' },
  });
  expect(signIn.ok()).toBe(true);
  const anonymousCookies = await page.context().cookies();
  await page.context().addCookies((await admin.storageState()).cookies);
  await page.goto('/app/settings?section=providers');
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByRole('button', { name: /Fish Audio S2/ }).click();
  const editor = page.getByRole('dialog', { name: 'Add Fish Audio', exact: true });
  await expect(editor.getByRole('button', { name: 'Default model', exact: true })).toContainText('S2.1 Pro Free');
  await editor.getByText('Advanced', { exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Slug', exact: true })).toHaveValue('fish-audio-2');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.context().clearCookies();
  await page.context().addCookies(anonymousCookies);
  const name = `Fish Audio ${testInfo.project.name}`;
  const created = await admin.post('/api/admin/providers', { data: {
    slug: `fish-${testInfo.project.name}`, displayName: name, providerType: 'fish-audio',
    defaultModel: 's2.1-pro-free',
  } });
  expect(created.status()).toBe(201);
  const { provider } = await created.json();
  try {
    await page.goto('/app/settings?section=api');
    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Model', exact: true })).toContainText('S2.1 Pro Free');
    await expect(page.getByRole('slider', { name: 'Model speed', exact: true })).toHaveAttribute('max', '2');
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await expect(page.getByRole('option', { name: 'S2.1 Pro', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Other', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: 'S2.1 Pro Free', exact: true }).click();
    await page.getByText('Custom voice ID', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Custom voice ID', exact: true }).fill('fish-reference-check');
    await page.getByRole('button', { name: 'Use voice', exact: true }).click();
    const unsaved = page.getByRole('region', { name: 'Unsaved changes', exact: true });
    await unsaved.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(unsaved).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button', { name: 'fish-reference-check', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Model', exact: true })).toContainText('S2.1 Pro Free');
    await page.screenshot({ path: `/private/tmp/fish-audio-${testInfo.project.name}.png` });
  } finally {
    await admin.delete(`/api/admin/providers/${provider.id}`);
    await admin.dispose();
  }
});
