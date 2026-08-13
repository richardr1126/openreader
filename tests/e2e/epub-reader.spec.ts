import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user opens an EPUB and reads its visible book content', async ({ page }) => {
  test.setTimeout(75_000);
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, resolve('tests/files/sample.epub'));

  const epubLink = page.getByRole('link', { name: 'sample.epub', exact: true });
  await expect(epubLink).toBeVisible();
  await epubLink.click();

  await expect(page).toHaveURL(/\/epub\/[a-f0-9]+$/);
  await expect(page.getByRole('heading', { name: 'sample.epub', exact: true })).toBeVisible({
    timeout: 60_000,
  });
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
