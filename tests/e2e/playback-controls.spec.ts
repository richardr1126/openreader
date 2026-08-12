import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

async function togglePlayback(
  page: Page,
  documentLink: Locator,
  documentName: string,
  readyTimeout = 30_000,
) {
  await documentLink.click();
  await expect(page.getByRole('heading', { name: documentName, exact: true })).toBeVisible({
    timeout: readyTimeout,
  });

  const playButton = page.getByRole('button', { name: 'Play', exact: true });
  await expect(playButton).toBeEnabled({ timeout: 30_000 });
  await playButton.focus();
  await page.keyboard.press('Enter');

  const pauseButton = page.getByRole('button', { name: 'Pause', exact: true });
  await expect(pauseButton).toBeVisible();
  await expect(pauseButton).toBeFocused();
  await page.keyboard.press('Space');
  await expect(playButton).toBeVisible();
  await expect(playButton).toBeFocused();

  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test('anonymous user starts and pauses playback in every accepted document journey', async ({ page }) => {
  test.setTimeout(120_000);
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, [
    resolve('tests/files/multilingual-sample.txt'),
    resolve('tests/files/sample.md'),
    resolve('tests/files/sample.epub'),
    resolve('tests/files/sample.pdf'),
  ]);

  for (const documentName of [
    'multilingual-sample.txt',
    'sample.md',
    'sample.epub',
  ]) {
    await expect(page.getByRole('link', { name: documentName, exact: true })).toBeVisible({
      timeout: 30_000,
    });
  }

  await page
    .getByRole('complementary')
    .getByText('Upload documents', { exact: true })
    .click();
  const uploadDialog = page.getByRole('dialog', { name: 'Add Documents', exact: true });
  await expect(uploadDialog.getByRole('heading', { name: 'Add Documents', exact: true })).toBeVisible();
  const docxChooserPromise = page.waitForEvent('filechooser');
  await uploadDialog
    .getByText('Drop your file(s) here, or click to select', { exact: true })
    .click();
  const docxChooser = await docxChooserPromise;
  await docxChooser.setFiles(resolve('tests/files/sample.docx'));

  const pdfLinks = page.getByRole('link', { name: 'sample.pdf', exact: true });
  await expect(pdfLinks).toHaveCount(2, { timeout: 30_000 });

  await togglePlayback(
    page,
    page.getByRole('link', { name: 'multilingual-sample.txt', exact: true }),
    'multilingual-sample.txt',
  );
  await togglePlayback(
    page,
    page.getByRole('link', { name: 'sample.md', exact: true }),
    'sample.md',
  );
  await togglePlayback(
    page,
    page.getByRole('link', { name: 'sample.epub', exact: true }),
    'sample.epub',
  );
  await togglePlayback(page, pdfLinks.nth(0), 'sample.pdf');
  await togglePlayback(page, pdfLinks.nth(1), 'sample.pdf', 60_000);
});
