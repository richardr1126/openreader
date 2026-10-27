import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('Kokoro warnings follow the document across the player, settings, export, and draft voices', async ({ page, playwright }, testInfo) => {
  test.setTimeout(90_000);
  // Compatible Kokoro's fallback voice catalogue is static and multilingual. Reading
  // needs no provider key; this journey never requests generation or previews.
  const admin = await playwright.request.newContext({ baseURL: 'http://localhost:3003' });
  const signIn = await admin.post('/api/auth/sign-in/email', {
    headers: { Origin: 'http://localhost:3003' },
    data: { email: 'admin-e2e@example.test', password: 'TestAccount#2026' },
  });
  expect(signIn.ok()).toBe(true);
  const providerName = `Kokoro language check ${testInfo.project.name}`;
  const created = await admin.post('/api/admin/providers', { data: {
    slug: `language-check-${testInfo.project.name}`, displayName: providerName,
    providerType: 'custom-openai', defaultModel: 'kokoro',
  } });
  expect(created.status()).toBe(201);
  const { provider } = await created.json();
  try {
    await enterAnonymousLibrary(page);
    await page.goto('/app/settings?section=api');
    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('option', { name: providerName, exact: true }).click();
    await page.getByRole('button', { name: 'af_heart', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Voice settings saved', { exact: true })).toBeVisible();
    await page.goto('/app');
    await uploadLibraryFiles(page, resolve('tests/files/french-sample.txt'));
    await page.getByRole('link', { name: 'french-sample.txt', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'french-sample.txt', exact: true })).toBeVisible();

    const mismatch = 'Selected Kokoro voice is American English, but the document is French. Select a French voice.';
    const warning = page.getByRole('img', { name: `Voice language warning: ${mismatch}`, exact: true });
    await expect(warning).toBeVisible();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Document settings', exact: true });
    await expect(settings.getByText('Detected: French', { exact: true })).toBeVisible();
    await expect(settings.getByText(mismatch, { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Open audiobook export', exact: true }).click();
    const exportPanel = page.getByRole('dialog', { name: 'Export audiobook', exact: true });
    await expect(exportPanel.getByText(mismatch, { exact: true })).toBeVisible();
    await exportPanel.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('button', { name: /^Voice: / }).click();
    const voices = page.getByRole('dialog', { name: 'Voice', exact: true });
    await expect(voices.getByText(mismatch, { exact: true })).toBeVisible();
    await voices.getByRole('button', { name: 'ff_siwis', exact: true }).click();
    await expect(voices.getByText(mismatch, { exact: true })).toHaveCount(0);
    // A draft does not change the applied voice or its warning until Apply.
    await expect(warning).toBeVisible();
    await voices.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Voice: ff_siwis', exact: true })).toBeVisible();
    await expect(warning).toHaveCount(0);
    await voices.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await settings.getByRole('button', { name: 'Automatic (voice or metadata)', exact: true }).click();
    await page.getByRole('option', { name: 'Turkish', exact: true }).click();
    await page.getByRole('dialog', { name: 'Change the document language?', exact: true })
      .getByRole('button', { name: 'Change and regenerate', exact: true }).click();
    await expect(settings.getByText("Kokoro's built-in voice catalog does not include Turkish. Choose another model.", { exact: true })).toBeVisible();
  } finally {
    await admin.delete(`/api/admin/providers/${provider.id}`);
    await admin.dispose();
  }
});

test('detected Turkish and manual German/Turkish survive reader preparation and reload', async ({ page }) => {
  test.setTimeout(60_000);
  await enterAnonymousLibrary(page);
  await uploadLibraryFiles(page, resolve('tests/files/turkish-sample.txt'));
  await page.getByRole('link', { name: 'turkish-sample.txt', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'turkish-sample.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Document settings', exact: true });
  await expect(settings.getByText('Detected: Turkish', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Automatic (voice or metadata)', exact: true }).click();
  await page.getByRole('option', { name: 'German', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Change the document language?', exact: true });
  // The reader confirms that changing language changes its audio cache scope.
  await confirmation.getByRole('button', { name: 'Change and regenerate', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'German', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'turkish-sample.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await settings.getByRole('button', { name: 'German', exact: true }).click();
  await page.getByRole('option', { name: 'Turkish', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Change and regenerate', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Turkish', exact: true })).toBeVisible();
});
