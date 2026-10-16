import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('keyboard user opens shortcuts and reader panels and returns focus', async ({ page }) => {
  test.setTimeout(45_000);
  await enterAnonymousLibrary(page);
  await uploadLibraryFiles(page, [resolve('tests/files/sample.md')]);

  await page.getByRole('link', { name: 'sample.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sample Markdown', level: 1 })).toBeVisible({
    timeout: 30_000,
  });

  // Playback shortcuts belong to the player bar.
  await expect(page.getByRole('slider', { name: 'Playback position', exact: true })).toBeVisible();
  await page.keyboard.press('Alt+Shift+KeyK');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  const shortcutsHeading = shortcuts.getByRole('heading', { name: 'Keyboard shortcuts' });
  await expect(shortcutsHeading).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(shortcutsHeading).toBeHidden();

  const openContents = page
    .getByRole('toolbar', { name: 'Reader' })
    .getByRole('button', { name: 'Open contents', exact: true });
  await openContents.focus();
  await page.keyboard.press('Enter');
  const contents = page.getByRole('dialog', { name: 'Contents' });
  await expect(contents.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(contents).toBeHidden();
  await expect(openContents).toBeFocused();
});
