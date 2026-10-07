import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user narrows the library by search words and reading status', async ({ page }) => {
  await enterAnonymousLibrary(page);
  await uploadLibraryFiles(page, [
    resolve('tests/files/sample.md'),
    resolve('tests/files/sample.pdf'),
  ]);

  const pdfLink = page.getByRole('link', { name: 'sample.pdf', exact: true });
  const markdownLink = page.getByRole('link', { name: 'sample.md', exact: true });

  // Every word must match, case-insensitively.
  const search = page.getByRole('textbox', { name: 'Search documents' });
  await search.fill('SAMPLE pdf');
  await expect(pdfLink).toBeVisible();
  await expect(markdownLink).toBeHidden();
  await search.fill('');
  await expect(markdownLink).toBeVisible();

  // Freshly uploaded documents are unread.
  await page.getByRole('button', { name: /^Reading status/ }).click();
  await page.getByRole('option', { name: 'In progress', exact: true }).click();
  await expect(pdfLink).toBeHidden();
  await expect(markdownLink).toBeHidden();

  await page.getByRole('button', { name: /^Reading status/ }).click();
  await page.getByRole('option', { name: 'Not started', exact: true }).click();
  await expect(pdfLink).toBeVisible();
  await expect(markdownLink).toBeVisible();
});
