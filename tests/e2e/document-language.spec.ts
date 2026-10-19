import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

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
