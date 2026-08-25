import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

async function openDocument(
  page: Page,
  documentLink: Locator,
  documentName: string,
  readyTimeout = 60_000,
) {
  await documentLink.click();
  await expect(page.getByRole('heading', { name: documentName, exact: true })).toBeVisible({
    timeout: readyTimeout,
  });
}

async function startAndPausePlayback(page: Page) {
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
}

async function returnToLibrary(page: Page) {
  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test('anonymous user controls playback across every accepted document journey', async ({ page }) => {
  test.setTimeout(180_000);
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
  await expect(pdfLinks).toHaveCount(2, { timeout: 60_000 });

  await openDocument(
    page,
    page.getByRole('link', { name: 'multilingual-sample.txt', exact: true }),
    'multilingual-sample.txt',
  );
  await startAndPausePlayback(page);

  const playButton = page.getByRole('button', { name: 'Play', exact: true });
  await page.getByRole('button', { name: 'Voice: F1', exact: true }).click();
  await page.getByRole('option', { name: 'F2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Voice: F2', exact: true })).toBeVisible();
  await expect(playButton).toBeEnabled({ timeout: 60_000 });

  await page.getByRole('button', { name: '1x', exact: true }).click();
  const nativeSpeed = page.getByRole('slider', { name: 'Native model speed', exact: true });
  const audioSpeed = page.getByRole('slider', { name: 'Audio player speed', exact: true });

  await nativeSpeed.focus();
  await nativeSpeed.press('ArrowRight');
  const changedSpeedButton = page.getByRole('button', { name: '1.1x', exact: true });
  await expect(changedSpeedButton).toBeEnabled({ timeout: 60_000 });

  await changedSpeedButton.click();
  await audioSpeed.focus();
  await audioSpeed.press('ArrowRight');
  await expect(page.getByRole('button', { name: '1.1x • 1.1x', exact: true })).toBeVisible();

  await playButton.click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'multilingual-sample.txt', exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Voice: F2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '1.1x • 1.1x', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await returnToLibrary(page);

  await openDocument(
    page,
    page.getByRole('link', { name: 'sample.md', exact: true }),
    'sample.md',
  );
  await startAndPausePlayback(page);
  await returnToLibrary(page);

  await openDocument(
    page,
    page.getByRole('link', { name: 'sample.epub', exact: true }),
    'sample.epub',
  );
  const bookTitle = page.frameLocator('iframe').getByRole('heading', {
    name: 'The Wonderful Wizard of Oz',
    exact: true,
  });
  await expect(bookTitle).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();

  const epubPlayButton = page.getByRole('button', { name: 'Play', exact: true });
  await expect(epubPlayButton).toBeEnabled({ timeout: 30_000 });
  await epubPlayButton.focus();
  await page.keyboard.press('Enter');
  const epubPauseButton = page.getByRole('button', { name: 'Pause', exact: true });
  await expect(epubPauseButton).toBeFocused();

  await page.setViewportSize({ width: 600, height: 800 });

  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  await expect(epubPauseButton).toBeVisible();
  await expect(bookTitle).toBeVisible();

  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const mobileMenu = page.getByRole('menu');
  await expect(mobileMenu.getByText('Zoom / Padding', { exact: true })).toBeVisible();
  await expect(mobileMenu.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });

  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();
  await expect(epubPauseButton).toBeVisible();
  await expect(bookTitle).toBeVisible();
  await epubPauseButton.click();
  await expect(epubPlayButton).toBeVisible();
  await returnToLibrary(page);

  await openDocument(page, pdfLinks.nth(0), 'sample.pdf');
  await startAndPausePlayback(page);
  await returnToLibrary(page);

  await openDocument(page, pdfLinks.nth(1), 'sample.pdf', 60_000);
  await startAndPausePlayback(page);
  await returnToLibrary(page);
});
