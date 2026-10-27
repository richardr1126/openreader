import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('tapping a sentence, contents and find in book move the Markdown reading position', async ({ page }) => {
  test.setTimeout(45_000);
  await enterAnonymousLibrary(page);
  await uploadLibraryFiles(page, resolve('tests/files/sample.md'));
  await page.getByRole('link', { name: 'sample.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'sample.md', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const sentence = page.locator('.openreader-html-highlight-sentence');
  await expect(sentence).toContainText('Sample Markdown');

  // Tap the start of a paragraph (not its link) to play from that sentence.
  await page.getByText(/for more information/).click({ position: { x: 4, y: 6 } });
  // A sentence that crosses a link is painted as one span per text run.
  await expect.poll(() => sentence.allTextContents().then((parts) => parts.join(' ')))
    .toBe('Visit OpenAI for more information');

  await page.getByRole('button', { name: 'Open contents', exact: true }).click();
  const contents = page.getByRole('dialog', { name: 'Contents' });
  // The panel slides in; a click during the slide lands on a moving target.
  await expect(contents).toBeInViewport({ ratio: 1 });
  await contents.getByRole('button', { name: 'Section One', exact: true }).click();
  await expect(sentence).toContainText('Section One');

  // Searching replaces the chapter list until the query is cleared.
  await page.getByRole('button', { name: 'Open contents', exact: true }).click();
  await expect(contents).toBeInViewport({ ratio: 1 });
  const search = contents.getByRole('searchbox', { name: 'Find in book' });
  await search.fill('BASIC markdown');
  await expect(contents.getByText('1 match', { exact: true })).toBeVisible();
  await contents.getByRole('list', { name: 'Search results' }).getByRole('button').first().click();
  await expect(sentence).toContainText('basic Markdown elements');
});

test('bookmarking the current sentence lists it, seeks to it, and deletes it', async ({ page }) => {
  test.setTimeout(45_000);
  await enterAnonymousLibrary(page);
  await uploadLibraryFiles(page, resolve('tests/files/sample.md'));
  await page.getByRole('link', { name: 'sample.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'sample.md', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const sentence = page.locator('.openreader-html-highlight-sentence');
  await page.getByText(/for more information/).click({ position: { x: 4, y: 6 } });
  // A sentence that crosses a link is painted as one span per text run.
  await expect.poll(() => sentence.allTextContents().then((parts) => parts.join(' ')))
    .toBe('Visit OpenAI for more information');

  const more = page.getByRole('button', { name: 'Menu', exact: true });
  const saveBookmark = page.getByRole('button', { name: 'Save bookmark', exact: true });
  const removeBookmark = page.getByRole('button', { name: 'Remove bookmark', exact: true });
  await more.click();
  await saveBookmark.click();
  await expect(saveBookmark).toBeHidden();
  await more.click();
  await expect(removeBookmark).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(removeBookmark).toBeHidden();

  // Move away, then return through the bookmarks panel.
  await page.getByRole('button', { name: 'Open contents', exact: true }).click();
  const contents = page.getByRole('dialog', { name: 'Contents' });
  // The panel slides in; a click during the slide lands on a moving target.
  await expect(contents).toBeInViewport({ ratio: 1 });
  await contents.getByRole('button', { name: 'Section One', exact: true }).click();
  await expect(sentence).toContainText('Section One');
  await more.click();
  await expect(saveBookmark).toBeVisible();
  await page.getByRole('button', { name: 'View bookmarks', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Bookmarks' });
  const list = panel.getByRole('list', { name: 'Bookmarks' });
  await expect(panel).toBeInViewport({ ratio: 1 });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: /^Visit/ }).click();
  // A sentence that crosses a link is painted as one span per text run.
  await expect.poll(() => sentence.allTextContents().then((parts) => parts.join(' ')))
    .toBe('Visit OpenAI for more information');
  await more.click();
  await expect(removeBookmark).toBeVisible();
  await page.getByRole('button', { name: 'View bookmarks', exact: true }).click();
  await expect(panel).toBeInViewport({ ratio: 1 });

  await list.getByRole('button', { name: /^Rename bookmark/ }).click();
  await panel.getByRole('textbox', { name: 'Bookmark name' }).fill('Further reading');
  await panel.getByRole('textbox', { name: 'Bookmark name' }).press('Enter');
  await expect(list.getByRole('button', { name: 'Further reading', exact: true })).toBeVisible();

  await list.getByRole('button', { name: 'Delete bookmark Further reading', exact: true }).click();
  await expect(panel.getByText(/No bookmarks yet/)).toBeVisible();
  await more.click();
  await expect(saveBookmark).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(saveBookmark).toBeHidden();
});

test('a PDF can be read as flowing text and tapped to seek', async ({ page }) => {
  test.setTimeout(75_000);
  await enterAnonymousLibrary(page);
  await uploadLibraryFiles(page, resolve('tests/files/sample.pdf'));
  await page.getByRole('link', { name: 'sample.pdf', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'sample.pdf', exact: true })).toBeVisible({
    timeout: 60_000,
  });

  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const showPages = page.getByRole('switch', { name: 'Show the pages' });
  await expect(showPages).toBeChecked();
  await showPages.click();
  await expect(showPages).not.toBeChecked();
  await page.getByRole('region', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Hide settings', exact: true }).click();

  const reader = page.getByTestId('text-reader');
  const target = reader.getByText('This is chapter one text used for integration tests.');
  await expect(target).toBeVisible();

  // Flowing text has no page scale, so the zoom control narrows the column instead.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const zoomControls = page.getByLabel('Zoom controls', { exact: true });
  await expect(zoomControls).toContainText('100%');
  const fullWidth = (await reader.boundingBox())!.width;
  await zoomControls.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(zoomControls).toContainText('90%');
  await expect.poll(async () => (await reader.boundingBox())!.width).toBeLessThan(fullWidth);
  await page.keyboard.press('Escape');
  await expect(zoomControls).toBeHidden();
  await target.click({ position: { x: 4, y: 6 } });
  await expect(reader.locator('.openreader-html-highlight-sentence').first())
    .toContainText('This is chapter one text');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});

test('a reader that cannot prepare keeps the way back to the library', async ({ page }) => {
  test.setTimeout(45_000);
  await enterAnonymousLibrary(page);
  await uploadLibraryFiles(page, resolve('tests/files/sample.md'));
  await page.route('**/api/documents/*/reader-bootstrap', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'We encountered an internal error, please try again.' }),
  }));

  await page.getByRole('link', { name: 'sample.md', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This document is not ready yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeDisabled();
  // The header keeps the ready layout, with reading controls disabled.
  await expect(page.getByRole('button', { name: 'Open contents', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeDisabled();

  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('link', { name: 'sample.md', exact: true })).toBeVisible();
});
