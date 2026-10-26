import { expect, test } from '@playwright/test';
import { pcmToWav } from '@openreader/tts/openrouter';
import { enterAnonymousLibrary } from './support/onboarding';

for (const providerType of ['fish-audio', 'openrouter'] as const) {
test(`${providerType} personal voices require sample permission and persist through selection, rename and removal`, async ({ page, playwright }, testInfo) => {
  await enterAnonymousLibrary(page);
  const admin = await playwright.request.newContext({ baseURL: 'http://localhost:3003' });
  expect((await admin.post('/api/auth/sign-in/email', { headers: { Origin: 'http://localhost:3003' },
    data: { email: 'admin-e2e@example.test', password: 'TestAccount#2026' } })).ok()).toBe(true);
  const providerName = `Cloning ${providerType} ${testInfo.project.name}`;
  const created = await admin.post('/api/admin/providers', { data: { slug: `cloning-${providerType}-${testInfo.project.name}`,
    displayName: providerName, providerType, defaultModel: providerType === 'fish-audio' ? 's2.1-pro-free' : 'fish-audio/s2.1-pro-free:free', apiKey: 'cloning-test-placeholder' } });
  expect(created.status()).toBe(201);
  const { provider } = await created.json();
  try {
    await page.goto('/app/settings?section=api');
    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('option', { name: providerName, exact: true }).click();
    await page.getByRole('button', { name: 'New voice', exact: true }).click();
    const editor = page.getByRole('region', { name: 'New voice', exact: true });
    await expect(editor.getByRole('button', { name: 'Save voice', exact: true })).toBeDisabled();
    await editor.getByLabel('Import voice sample', { exact: true }).setInputFiles({ name: 'reference.wav', mimeType: 'audio/wav',
      buffer: Buffer.from(pcmToWav(new Uint8Array(96_000))) });
    await editor.getByRole('textbox', { name: 'Voice name', exact: true }).fill('My narrator');
    await expect(editor.getByRole('slider', { name: 'Sample length', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Save voice', exact: true })).toBeDisabled();
    await editor.getByRole('checkbox').check();
    await editor.getByRole('button', { name: 'Save voice', exact: true }).click();
    await expect(page.getByRole('button', { name: 'My narrator', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const library = await (await page.request.get('/api/tts/cloned-voices')).json();
    expect(library.voices[0].audio).toBeUndefined();
    const unsaved = page.getByRole('region', { name: 'Unsaved changes', exact: true });
    await unsaved.getByRole('button', { name: 'Save', exact: true }).click(); await expect(unsaved).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button', { name: 'My narrator', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Manage My narrator', exact: true }).click();
    await page.getByRole('textbox', { name: 'Rename voice', exact: true }).fill('Renamed narrator');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Renamed narrator', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Renamed narrator', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/private/tmp/openreader-voice-cloning/web-${testInfo.project.name}.png` });
    await page.getByRole('button', { name: 'Manage Renamed narrator', exact: true }).click();
    await page.getByRole('button', { name: 'Delete saved voice', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Renamed narrator', exact: true })).toHaveCount(0);
  } finally { await admin.delete(`/api/admin/providers/${provider.id}`); await admin.dispose(); }
});
}
