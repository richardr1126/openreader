import { expect, test } from '@playwright/test';
import { signInAdmin } from './support/admin';
import { enterAnonymousLibrary } from './support/onboarding';

test('OpenRouter discovers models, gates instructions and layers user over provider model options', async ({ page, playwright }, testInfo) => {
  await enterAnonymousLibrary(page);
  const admin = await signInAdmin(playwright);
  const anonymousCookies = await page.context().cookies();
  await page.context().addCookies(admin.cookies);
  await page.goto('/app/settings?section=providers');
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  const services = page.getByRole('list', { name: 'Provider services' }).getByRole('button');
  await expect(services.nth(0)).toContainText('OpenRouter');
  await expect(services.nth(1)).toContainText('Fish Audio');
  await expect(services.nth(2)).toContainText('OpenAI');
  await services.nth(0).click();
  const editor = page.getByRole('dialog', { name: 'Add OpenRouter', exact: true });
  await expect(editor.getByRole('button', { name: 'Default model', exact: true })).toContainText('S2.1 Pro Free');
  await expect(editor.getByRole('textbox', { name: 'TTS instructions', exact: true })).toBeVisible();
  await editor.getByText('Advanced', { exact: true }).click();
  await editor.getByRole('textbox', { name: 'Model options', exact: true }).fill('{"provider":');
  await expect(editor.getByRole('alert').filter({ hasText: 'valid JSON' })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Add provider', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.context().clearCookies(); await page.context().addCookies(anonymousCookies);
  const name = `OpenRouter ${testInfo.project.name} ${testInfo.repeatEachIndex}`;
  const provider = await admin.createProvider({
    slug: `router-${testInfo.project.name}-${testInfo.repeatEachIndex}`, displayName: name, providerType: 'openrouter', defaultModel: 'fish-audio/s2.1-pro-free:free',
    defaultInstructions: 'Calm librarian',
    defaultModelOptions: '{"provider":{"options":{"fish-audio":{"temperature":0.4}}}}',
  });
  try {
    await page.goto('/app/settings?section=api');
    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sarah', exact: true })).toBeVisible();
    const catalogResponse = await page.request.get('/api/tts/models');
    expect(catalogResponse.ok()).toBe(true);
    const { models } = await catalogResponse.json();
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await expect(page.getByRole('option')).toHaveCount(models.length + 1);
    await page.getByRole('option', { name: /Fish Audio: S2.1 Pro Free/ }).click();
    const instructions = page.getByRole('textbox', { name: 'Voice instructions', exact: true });
    await expect(instructions).toHaveValue('Calm librarian');
    await instructions.fill('Warm narration');
    const disclosure = page.getByRole('button', { name: 'Advanced model options', exact: true });
    await expect(disclosure).toContainText('Provider default');
    await disclosure.click();
    const options = page.getByRole('textbox', { name: 'Model options', exact: true });
    await expect(options).toHaveValue(/"temperature": 0.4/);
    await options.fill('{"provider":');
    await expect(page.getByRole('alert').filter({ hasText: 'valid JSON' })).toBeVisible();
    await options.fill('{"provider":{"options":{"fish-audio":{"temperature":0.7}}}}');
    const unsaved = page.getByRole('region', { name: 'Unsaved changes', exact: true });
    await unsaved.getByRole('button', { name: 'Save', exact: true }).click(); await expect(unsaved).toBeHidden();
    await page.reload();
    await expect(instructions).toHaveValue('Warm narration');
    await page.getByRole('button', { name: 'Use provider default', exact: true }).click();
    await expect(instructions).toHaveValue('Calm librarian');
    await expect(disclosure).toContainText('Custom for Fish Audio: S2.1 Pro Free');
    await disclosure.click();
    await expect(options).toHaveValue(/"temperature": 0.7/);
    await expect(page.getByRole('button', { name: 'Sarah', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await page.getByRole('option', { name: 'Google: Gemini 3.8 Flash Lite TTS', exact: true }).click();
    await expect(options).toHaveValue('');
    await expect(page.getByRole('textbox', { name: 'Voice instructions', exact: true })).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Model speed', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Kore', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await page.getByRole('option', { name: 'hexgrad: Kokoro 82M', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Voice instructions', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'af_heart', exact: true })).toBeVisible();
    await unsaved.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(options).toHaveValue(/"temperature": 0.7/);
    await page.screenshot({ path: test.info().outputPath('openrouter.png') });
  } finally {
    await admin.deleteProvider(provider.id);
  }
});
