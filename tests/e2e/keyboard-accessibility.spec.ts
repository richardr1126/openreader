import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('keyboard user controls reader panels and playback shortcuts', async ({ page }) => {
  test.setTimeout(45_000);
  await enterAnonymousLibrary(page);
  await uploadLibraryFiles(page, [resolve('tests/files/sample.md')]);

  await page.getByRole('link', { name: 'sample.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sample Markdown', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  const playButton = page.getByRole('button', { name: 'Play', exact: true });
  await expect(playButton).toHaveAttribute('aria-keyshortcuts', 'Space');

  const openContents = page.getByRole('button', { name: 'Open contents', exact: true });
  await openContents.focus();
  await page.keyboard.press('Enter');
  const contents = page.getByRole('dialog', { name: 'Contents' });
  await expect(contents.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(contents).toBeHidden();
  await expect(openContents).toBeFocused();

  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Document settings' });
  await expect(settings.getByRole('switch', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  const bookUrl = page.url();
  await page.goto('/app/settings?section=reader');
  const shortcuts = page.getByRole('switch', { name: 'Keyboard shortcuts' });
  const keys = page.getByLabel('Playback keys');
  await expect(shortcuts).toBeChecked();
  await expect(keys).toContainText('Play or pause');
  await shortcuts.click();
  await expect(shortcuts).not.toBeChecked();
  await expect(keys).toBeHidden();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unsaved changes', exact: true })).toBeHidden();
  await page.goto(bookUrl);
  await expect(playButton).toBeVisible();
  await expect(playButton).not.toHaveAttribute('aria-keyshortcuts', /.+/);
});
