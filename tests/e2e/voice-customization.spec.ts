import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { signInAdmin } from './support/admin';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function saveBook(page: Page) {
  await page.getByRole('region', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Change and regenerate', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
}

async function expectInlineSetting(page: Page, label: string) {
  const button = page.getByRole('button', { name: label, exact: true });
  await button.scrollIntoViewIfNeeded();
  await expect.poll(async () => {
    const [text, control] = await Promise.all([
      page.getByText(label, { exact: true }).boundingBox(), button.boundingBox(),
    ]);
    return text && control ? Math.abs(text.y + text.height / 2 - control.y - control.height / 2) : Infinity;
  }).toBeLessThan(2);
}

test('added pauses keep Automatic defaults and independent book inheritance', async ({ page, playwright }, testInfo) => {
  test.setTimeout(75_000);
  await enterAnonymousLibrary(page);
  // A local model is optional on a hosted installation. Configure one through
  // the supported admin API without changing the stack's default provider.
  const admin = await signInAdmin(playwright);
  const providerName = `Local pause check ${testInfo.project.name}`;
  const provider = await admin.createProvider({
    slug: `pause-check-${testInfo.project.name}`, displayName: providerName,
    providerType: 'kokoro-local', defaultModel: 'kokoro',
  });
  try {
    await page.goto('/app/settings?section=api');
    const between = page.getByRole('button', { name: 'Between segments', exact: true });
    await expect(page.getByRole('button', { name: 'Advanced', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(between).toBeHidden();
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(between).toContainText('Automatic (0 ms)');
    await expectInlineSetting(page, 'Between segments');
    await choose(page, 'Between segments', 'Custom…');
    const pauseSlider = page.getByRole('slider', { name: 'Adjust between segments', exact: true });
    await expect(pauseSlider).toBeVisible();
    await pauseSlider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(between).toHaveText('50 ms');
    await choose(page, 'Between segments', '500 ms');
    await expect(pauseSlider).toHaveCount(0);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(between).toContainText('Automatic (0 ms)');
    await choose(page, 'Between segments', '500 ms');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Unsaved changes', exact: true })).toBeHidden();
    await page.reload();
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(between).toContainText('500 ms');

    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('option', { name: providerName, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Piece length', exact: true })).toHaveText('Automatic');
    await expect(page.getByRole('button', { name: 'Between pieces', exact: true })).toContainText('Automatic (0 ms)');
    await choose(page, 'Piece length', '100 characters');
    await choose(page, 'Between pieces', '150 ms');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Unsaved changes', exact: true })).toBeHidden();
    await page.reload();
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Piece length', exact: true })).toContainText('100 characters');
    await expect(page.getByRole('button', { name: 'Between pieces', exact: true })).toContainText('150 ms');

    await page.getByRole('link', { name: 'Close settings', exact: true }).click();
    await uploadLibraryFiles(page, resolve('tests/files/sample.md'));
    await page.getByRole('link', { name: 'sample.md', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Document text', exact: true })).toBeVisible();
    const originalText = await page.getByRole('region', { name: 'Document text', exact: true }).innerText();
    const originalPosition = await page.getByRole('slider', { name: 'Playback position', exact: true }).inputValue();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(between).toContainText('500 ms');
    await choose(page, 'Between segments', '0 ms');
    await page.getByRole('region', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Unsaved changes', exact: true })).toBeVisible();
    await page.route('**/api/documents/*/settings', async route => {
      if (route.request().method() === 'PUT') await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
      else await route.continue();
    });
    await page.getByRole('region', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Change and regenerate', exact: true }).click();
    await expect(page.getByText('Could not save this book’s speech settings', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(between).toHaveText('0 ms');
    await page.unroute('**/api/documents/*/settings');
    await saveBook(page);
    await page.reload();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(between).toHaveText('0 ms');
    await expect(page.getByRole('button', { name: 'Between pieces', exact: true })).toContainText('150 ms');
    await choose(page, 'Between pieces', 'Automatic (0 ms)');
    await saveBook(page);
    await expect(page.getByRole('button', { name: 'Use app default for between pieces', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Use app default for between segments', exact: true }).click();
    await saveBook(page);
    await expect(between).toContainText('500 ms');
    await expect(page.getByRole('button', { name: 'Between pieces', exact: true })).toContainText('Automatic (0 ms)');
    await expect(page.getByRole('button', { name: 'Use app default for between segments', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Document text', exact: true })).toHaveText(originalText, { useInnerText: true });
    await expect(page.getByRole('slider', { name: 'Playback position', exact: true })).toHaveValue(originalPosition);
    await page.getByRole('heading', { name: 'Added pauses', exact: true }).scrollIntoViewIfNeeded();
    await expectInlineSetting(page, 'Piece length');
    await expectInlineSetting(page, 'Between pieces');
    await expectInlineSetting(page, 'Between segments');
    await page.screenshot({ path: test.info().outputPath('voice-customization-web.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('heading', { name: 'Added pauses', exact: true }).scrollIntoViewIfNeeded();
    for (const label of ['Piece length', 'Between pieces', 'Between segments']) {
      await expectInlineSetting(page, label);
      expect(await page.getByRole('button', { name: label, exact: true }).evaluate(button => {
        const value = button.firstElementChild!;
        return value.scrollWidth <= value.clientWidth;
      })).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath('voice-customization-web-mobile.png') });
  } finally {
    await admin.deleteProvider(provider.id);
  }
});
