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
  await expect(sentence).toContainText('Visit');

  await page.getByRole('button', { name: 'Open contents', exact: true }).click();
  const contents = page.getByRole('dialog', { name: 'Contents' });
  await contents.getByRole('button', { name: 'Section One', exact: true }).click();
  await expect(sentence).toContainText('Section One');

  await page.getByRole('button', { name: 'Find in book', exact: true }).click();
  const find = page.getByRole('dialog', { name: 'Find in book' });
  await find.getByRole('searchbox', { name: 'Find in book' }).fill('BASIC markdown');
  await expect(find.getByText('1 match', { exact: true })).toBeVisible();
  await find.getByRole('list', { name: 'Search results' }).getByRole('button').first().click();
  await expect(sentence).toContainText('basic Markdown elements');
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
  await page.getByRole('button', { name: 'Hide settings', exact: true }).click();

  const reader = page.getByTestId('plan-text-reader');
  const target = reader.getByText('This is chapter one text used for integration tests.', { exact: true });
  await expect(target).toBeVisible();
  await target.click();
  await expect(target).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});
