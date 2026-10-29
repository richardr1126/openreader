import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

for (const showsLayout of [true, false]) {
  test(`PDF with an image-only cover opens without a saved position in ${showsLayout ? 'layout' : 'text'} view`, async ({ page }) => {
    test.setTimeout(75_000);
    await enterAnonymousLibrary(page);
    if (!showsLayout) {
      await page.goto('/app/settings?section=customize');
      await page.getByRole('switch', { name: 'Show the pages', exact: true }).click();
      await page.getByRole('region', { name: 'Unsaved changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Unsaved changes', exact: true })).toBeHidden();
      await page.getByRole('link', { name: 'Close settings', exact: true }).click();
    }
    await uploadLibraryFiles(page, resolve('tests/files/cover-first.pdf'));
    await page.getByRole('link', { name: 'cover-first.pdf', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('progressbar', { name: 'Opening document', exact: true })).toBeHidden();
    if (showsLayout) {
      await expect(page.getByRole('region', { name: 'PDF page 1', exact: true })).toBeInViewport();
      await expect(page.getByRole('button', { name: '1 / 3', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
    }
    await expect(page.getByText('Reading begins after the illustrated cover.', { exact: true })).toBeVisible();

    // The initial fallback must not override a cursor saved later in the book.
    const position = page.getByRole('slider', { name: 'Playback position', exact: true });
    const savedPosition = page.waitForResponse((response) => (
      response.url().endsWith('/api/user/state/progress')
      && response.request().method() === 'PUT'
      && response.request().postDataJSON()?.segmentOrdinal > 0
      && response.ok()
    ));
    await position.focus();
    await position.press('End');
    await position.press('Enter');
    await expect(page.getByText('This is the final page of the document.', { exact: true })).toBeVisible();
    await savedPosition;
    await page.reload();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(position).not.toHaveValue('0');
    await expect(page.getByText('This is the final page of the document.', { exact: true })).toBeVisible();
  });
}

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
  await expect(page.getByRole('button', { name: 'Open contents', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  const pager = page.getByRole('group', { name: 'Reading position', exact: true });
  await expect(pager.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await expect(pager.getByRole('button', { name: '1 / 2', exact: true })).toBeVisible();
  await expect(pager.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();

  // A committed scrub offers a short-lived way back to where the listener was.
  const position = page.getByRole('slider', { name: 'Playback position', exact: true });
  await expect.poll(async () => Number(await position.getAttribute('max'))).toBeGreaterThan(0);
  await position.focus();
  await position.press('End');
  await position.press('Enter');
  const undoScrub = page.getByRole('button', { name: 'Undo scrub', exact: true });
  await expect(undoScrub).toBeVisible();
  expect(Number(await position.inputValue())).toBeGreaterThan(0);
  await undoScrub.click();
  await expect(undoScrub).toBeHidden();
  await expect(position).toHaveValue('0');

  // A pointer click lands mid-sentence and snaps to the sentence start; the
  // trailing change event must not reopen the scrub and hold the playhead.
  const track = await position.boundingBox();
  if (!track) throw new Error('Playback position slider has no layout box');
  await position.click({ position: { x: track.width * 0.6, y: track.height / 2 } });
  await expect(undoScrub).toBeVisible();
  expect(Number(await position.inputValue())).toBeGreaterThan(0);
  await undoScrub.click();
  await expect(undoScrub).toBeHidden();
  await expect(position).toHaveValue('0');

  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('link', { name: 'sample.pdf', exact: true })).toBeVisible();
});
