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
  await expect(page.getByRole('button', { name: 'Open contents', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  const position = page.getByRole('group', { name: 'Reading position', exact: true });
  await expect(position.getByRole('button', { name: 'Previous section', exact: true })).toBeVisible();
  await expect(position.getByRole('button', { name: 'Next section', exact: true })).toBeVisible();
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

  await expect.poll(async () => {
    const [container, frame] = await Promise.all([
      page.locator('.epub-container').boundingBox(),
      page.locator('.epub-container iframe').first().boundingBox(),
    ]);
    if (!container || !frame) return Number.POSITIVE_INFINITY;
    return Math.abs(container.height - frame.height);
  }).toBeLessThanOrEqual(1);

  // Following the book's own contents link selects that chapter for playback.
  await book.getByRole('link', { name: 'Chapter I. The Cyclone', exact: true }).click();
  await expect(book.getByRole('heading', { name: /^Chapter I\b/ })).toBeVisible();
  await page.getByRole('button', { name: 'Open contents', exact: true }).click();
  const contents = page.getByRole('dialog', { name: 'Contents' });
  await expect(contents).toBeInViewport({ ratio: 1 });
  const chapters = contents.getByRole('list', { name: 'Chapters' }).getByRole('button');
  await expect(chapters.nth(3)).toHaveText('Chapter II The Council with the Munchkins');
  await expect(chapters.nth(2)).toHaveAttribute('aria-current', 'true');
});
