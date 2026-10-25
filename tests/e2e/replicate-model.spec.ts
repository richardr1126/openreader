import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';

test('Replicate offers the current Inworld model and its voices', async ({ page, playwright }, testInfo) => {
  await enterAnonymousLibrary(page);
  const admin = await playwright.request.newContext({ baseURL: 'http://localhost:3003' });
  const signIn = await admin.post('/api/auth/sign-in/email', {
    headers: { Origin: 'http://localhost:3003' },
    data: { email: 'admin-e2e@example.test', password: 'TestAccount#2026' },
  });
  expect(signIn.ok()).toBe(true);
  const name = `Inworld catalog ${testInfo.project.name}`;
  const created = await admin.post('/api/admin/providers', { data: {
    slug: `inworld-catalog-${testInfo.project.name}`, displayName: name, providerType: 'replicate',
    defaultModel: 'inworld/realtime-tts-1.5-mini',
  } });
  expect(created.status()).toBe(201);
  const { provider } = await created.json();
  try {
    await page.goto('/app/settings?section=api');
    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Model', exact: true })).toContainText('inworld/realtime-tts-1.5-mini');
    await expect(page.getByRole('button', { name: 'Ashley', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await expect(page.getByRole('option', { name: 'inworld/realtime-tts-1.5-mini', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'inworld/tts-1.5-mini', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /alphanumericuser\/kokoro-82m/ })).toHaveCount(0);
  } finally {
    await admin.delete(`/api/admin/providers/${provider.id}`);
    await admin.dispose();
  }
});
