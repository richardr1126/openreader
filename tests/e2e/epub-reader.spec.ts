import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

test('anonymous user opens an EPUB and reads its visible book content', async ({ page }) => {
  await page.goto('/app');

  const privacyDialog = page.getByRole('dialog', {
    name: 'Privacy & Data Usage',
    exact: true,
  });
  await privacyDialog
    .getByRole('checkbox', {
      name: 'I have read and agree to the',
      exact: true,
    })
    .check();
  await privacyDialog.getByRole('button', { name: 'Continue', exact: true }).click();

  const backToSettings = page.getByRole('button', {
    name: 'Back to settings',
    exact: true,
  });
  await expect(backToSettings).toBeVisible();
  await backToSettings.click();

  const settingsDialog = page.getByRole('dialog', { name: /^Settings/ });
  const closeSettings = settingsDialog.getByRole('button', {
    name: 'Close dialog',
    exact: true,
  });
  await expect(closeSettings).toBeVisible();
  await closeSettings.click();
  await expect(settingsDialog).toBeHidden();

  const declineOptionalCookies = page.getByRole('button', {
    name: 'Decline Non-Essential',
    exact: true,
  });
  await declineOptionalCookies.click();
  await expect(declineOptionalCookies).toBeHidden();

  const chooserPromise = page.waitForEvent('filechooser');
  await page
    .getByText('Drop your file(s) here, or click to select', { exact: true })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles(resolve('tests/files/sample.epub'));

  const epubLink = page.getByRole('link', { name: 'sample.epub', exact: true });
  await expect(epubLink).toBeVisible();
  await epubLink.click();

  await expect(page).toHaveURL(/\/epub\/[a-f0-9]+$/);
  await expect(page.getByRole('heading', { name: 'sample.epub', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show chapters', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous section', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next section', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Playback position', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  const book = page.frameLocator('iframe');
  await expect(
    book.getByRole('heading', {
      name: 'The Project Gutenberg eBook of The Wonderful Wizard of Oz',
      exact: true,
    }),
  ).toBeVisible();
  await expect(book.getByRole('heading', { name: 'The Wonderful Wizard of Oz', exact: true })).toBeVisible();
  await expect(book.getByText('by L. Frank Baum', { exact: true })).toBeVisible();
  await expect(book.getByRole('link', { name: 'Chapter I. The Cyclone', exact: true })).toBeVisible();
});
