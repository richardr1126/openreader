import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';

test('anonymous user uploads PDF, EPUB, and TXT documents into the library', async ({ page }) => {
  await enterAnonymousLibrary(page);

  const chooserPromise = page.waitForEvent('filechooser');
  await page
    .getByText('Drop your file(s) here, or click to select', { exact: true })
    .click();
  const chooser = await chooserPromise;

  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([
    resolve('tests/files/sample.pdf'),
    resolve('tests/files/sample.epub'),
    resolve('tests/files/multilingual-sample.txt'),
  ]);

  await expect(page.getByText('Uploading', { exact: true })).toBeVisible();

  const pdfLink = page.getByRole('link', { name: 'sample.pdf', exact: true });
  const epubLink = page.getByRole('link', { name: 'sample.epub', exact: true });
  const textLink = page.getByRole('link', {
    name: 'multilingual-sample.txt',
    exact: true,
  });

  await expect(pdfLink).toBeVisible();
  await expect(epubLink).toBeVisible();
  await expect(textLink).toBeVisible();
  await expect(pdfLink).toHaveAttribute('href', /^\/pdf\/[a-f0-9]+$/);
  await expect(epubLink).toHaveAttribute('href', /^\/epub\/[a-f0-9]+$/);
  await expect(textLink).toHaveAttribute('href', /^\/html\/[a-f0-9]+$/);

  await expect(page.getByRole('button', { name: 'PDF 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'EPUB 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Text 1', exact: true })).toBeVisible();

  const libraryStatus = page.getByRole('status');
  await expect(libraryStatus).toContainText('1 PDF');
  await expect(libraryStatus).toContainText('1 EPUB');
  await expect(libraryStatus).toContainText('1 Text Doc');
  await expect(libraryStatus).toContainText('3 items');
});
