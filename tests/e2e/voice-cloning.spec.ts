import { expect, test } from '@playwright/test';
import { pcmToWav } from '@openreader/tts/openrouter';
import { resolve } from 'node:path';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

for (const providerType of ['fish-audio', 'openrouter'] as const) {
test(`${providerType} personal voices require sample permission and persist through selection, rename and removal`, async ({ page, playwright }, testInfo) => {
  test.setTimeout(90_000);
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
    if (providerType === 'fish-audio') {
      // Legacy/inherited drafts can carry a model from the previous provider.
      // The picker already displays Fish's free preset; cloning must use it
      // on initial load, without reselecting the displayed model.
      const saved = await page.request.put('/api/user/state/preferences', { data: {
        patch: { providerRef: provider.slug, providerType, ttsModel: 'kokoro', voice: '' }, clientUpdatedAtMs: Date.now(),
      } });
      expect(saved.ok()).toBe(true);
      expect((await saved.json()).preferences.ttsModel).toBe('kokoro');
      const capability = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === '/api/tts/cloned-voices' && url.searchParams.get('providerRef') === provider.slug;
      });
      await page.goto('/app/settings?section=api');
      const response = await capability;
      expect(new URL(response.url()).searchParams.get('model')).toBe('s2.1-pro-free');
      expect((await response.json()).supportsCloning).toBe(true);
      await expect(page.getByRole('button', { name: 'Model', exact: true })).toContainText('S2.1 Pro Free');
      await expect(page.getByText('Voice cloning is unavailable for this model.', { exact: true })).toHaveCount(0);
    } else {
      await page.goto('/app/settings?section=api');
      await page.getByRole('button', { name: 'Provider', exact: true }).click();
      await page.getByRole('option', { name: providerName, exact: true }).click();
    }
    await page.getByRole('button', { name: 'Create your own voice', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Create your own voice', exact: true });
    await expect(editor.getByRole('heading', { name: 'For the best result' })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Record Read a short passage', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Import Use an audio file', exact: true })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath('unified-web.png') });
    await editor.getByLabel('Import voice sample', { exact: true }).setInputFiles({ name: 'reference.wav', mimeType: 'audio/wav',
      buffer: Buffer.from(pcmToWav(new Uint8Array(96_000))) });
    await editor.getByRole('textbox', { name: 'Voice name', exact: true }).fill('My narrator');
    await expect(editor.getByRole('slider', { name: 'Sample length', exact: true })).toBeVisible();
    if (providerType === 'fish-audio') {
      await expect(editor.getByRole('button', { name: 'Add the transcript to save', exact: true })).toBeDisabled();
      await editor.getByRole('textbox', { name: 'Sample transcript', exact: true }).fill('A clear reference sample.');
    }
    await expect(editor.getByRole('button', { name: 'Confirm permission to save', exact: true })).toBeDisabled();
    await editor.getByRole('checkbox').check();
    await editor.getByRole('button', { name: 'Save voice', exact: true }).click();
    await expect(page.getByRole('button', { name: 'My narrator', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const library = await (await page.request.get('/api/tts/cloned-voices')).json();
    expect(library.voices[0].audio).toBeUndefined();
    const unsaved = page.getByRole('region', { name: 'Unsaved changes', exact: true });
    await unsaved.getByRole('button', { name: 'Save', exact: true }).click(); await expect(unsaved).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button', { name: 'My narrator', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'More for My narrator', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Rename voice', exact: true });
    await rename.getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed narrator');
    await rename.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Renamed narrator', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Renamed narrator', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('web.png') });
    // The reader dock names the personal voice, never its clone ID.
    await page.getByRole('link', { name: 'Close settings', exact: true }).click();
    await uploadLibraryFiles(page, resolve('tests/files/sample.md'));
    await page.getByRole('link', { name: 'sample.md', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Voice:/ }).first()).toHaveAttribute('aria-label', 'Voice: Renamed narrator');
    await page.goto('/app/settings?section=api');
    await page.getByRole('button', { name: 'More for Renamed narrator', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: 'Delete Renamed narrator?', exact: true });
    await expect(page.getByRole('button', { name: 'Renamed narrator', exact: true })).toBeVisible();
    // Removing a selected sample must update the list and selection even
    // when the follow-up catalog refresh cannot reach the server.
    const refreshRoute = '**/api/tts/cloned-voices?**';
    await page.route(refreshRoute, route => route.abort());
    try {
      await deletion.getByRole('button', { name: 'Delete voice', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Renamed narrator', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Create your own voice', exact: true })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Voices', exact: true }).getByRole('button', { pressed: true })).toHaveCount(1);
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
    await unsaved.getByRole('button', { name: 'Save', exact: true }).click(); await expect(unsaved).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Renamed narrator', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create your own voice', exact: true })).toBeVisible();
  } finally { await admin.delete(`/api/admin/providers/${provider.id}`); await admin.dispose(); }
});
}
