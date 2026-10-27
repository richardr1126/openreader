import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';

test('Google AI Studio replaces the removed service and persists speech settings', async ({ page, playwright }, testInfo) => {
  await enterAnonymousLibrary(page);
  const admin = await playwright.request.newContext({ baseURL: 'http://localhost:3003' });
  const signIn = await admin.post('/api/auth/sign-in/email', {
    headers: { Origin: 'http://localhost:3003' }, data: { email: 'admin-e2e@example.test', password: 'TestAccount#2026' },
  });
  expect(signIn.ok()).toBe(true);
  const anonymousCookies = await page.context().cookies();
  await page.context().addCookies((await admin.storageState()).cookies);
  await page.goto('/app/settings?section=providers');
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  const services = page.getByRole('list', { name: 'Provider services' });
  await expect(services.getByRole('button', { name: /DeepInfra/i })).toHaveCount(0);
  await services.getByRole('button', { name: /Google AI Studio/ }).click();
  const editor = page.getByRole('dialog', { name: 'Add Google AI Studio', exact: true });
  await expect(editor.getByRole('button', { name: 'Default model', exact: true })).toContainText('Gemini 3.8 Flash TTS');
  await expect(editor.getByRole('textbox', { name: 'TTS instructions', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.context().clearCookies(); await page.context().addCookies(anonymousCookies);

  const name = `Google AI Studio ${testInfo.project.name}`;
  const created = await admin.post('/api/admin/providers', { data: {
    slug: `google-${testInfo.project.name}`, displayName: name, providerType: 'google-ai-studio',
    defaultModel: 'gemini-3.8-flash-tts', defaultInstructions: 'Calm narration',
  } });
  expect(created.status()).toBe(201);
  const { provider } = await created.json();
  try {
    await page.goto('/app/settings?section=api');
    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Zephyr', exact: true })).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Model speed', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Other', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: 'Gemini 3.8 Flash-Lite TTS', exact: true }).click();
    await page.getByRole('button', { name: 'Kore', exact: true }).click();
    await page.getByRole('textbox', { name: 'Voice instructions', exact: true }).fill('Calm, warm narration');
    const unsaved = page.getByRole('region', { name: 'Unsaved changes', exact: true });
    await unsaved.getByRole('button', { name: 'Save', exact: true }).click(); await expect(unsaved).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Model', exact: true })).toContainText('Gemini 3.8 Flash-Lite TTS');
    await expect(page.getByRole('button', { name: 'Kore', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('textbox', { name: 'Voice instructions', exact: true })).toHaveValue('Calm, warm narration');
    await page.screenshot({ path: test.info().outputPath('google-ai-studio.png') });
  } finally {
    await admin.delete(`/api/admin/providers/${provider.id}`); await admin.dispose();
  }
});
