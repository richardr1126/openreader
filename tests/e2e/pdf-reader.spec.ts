import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user opens a PDF and reads its visible page content', async ({ page }) => {
  test.setTimeout(75_000);
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, resolve('tests/files/sample.pdf'));

  const pdfLink = page.getByRole('link', { name: 'sample.pdf', exact: true });
  await expect(pdfLink).toBeVisible();
  await pdfLink.click();

  await expect(page).toHaveURL(/\/pdf\/[a-f0-9]+$/);
  await expect(page.getByRole('heading', { name: 'sample.pdf', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Chapter One', { exact: true })).toBeVisible();
  await expect(
    page.getByText('This is chapter one text used for integration tests.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Playback position', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '1 / 2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();

  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('link', { name: 'sample.pdf', exact: true })).toBeVisible();
});
