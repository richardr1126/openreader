import { resolve } from 'node:path';

import { expect, test, type Locator } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

async function expectHighlightInsidePage(highlight: Locator, pdfPage: Locator) {
  await expect(async () => {
    const [highlightBox, pageBox] = await Promise.all([
      highlight.boundingBox(),
      pdfPage.boundingBox(),
    ]);

    expect(highlightBox).not.toBeNull();
    expect(pageBox).not.toBeNull();
    expect(highlightBox!.x).toBeGreaterThanOrEqual(pageBox!.x);
    expect(highlightBox!.y).toBeGreaterThanOrEqual(pageBox!.y);
    expect(highlightBox!.x + highlightBox!.width).toBeLessThanOrEqual(
      pageBox!.x + pageBox!.width,
    );
    expect(highlightBox!.y + highlightBox!.height).toBeLessThanOrEqual(
      pageBox!.y + pageBox!.height,
    );
  }).toPass({ timeout: 10_000 });
}

test('PDF sentence highlight survives narrowing and widening the reader', async ({ page }) => {
  test.setTimeout(75_000);
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, resolve('tests/files/sample.pdf'));
  await page.getByRole('link', { name: 'sample.pdf', exact: true }).click();

  await expect(page).toHaveURL(/\/pdf\/[a-f0-9]+$/);
  await expect(page.getByRole('heading', { name: 'sample.pdf', exact: true })).toBeVisible({
    timeout: 60_000,
  });

  const pageOne = page.getByRole('region', { name: 'PDF page 1', exact: true });
  const sentenceHighlight = page.getByTestId('pdf-sentence-highlight').first();

  await expect(pageOne).toBeInViewport();
  await expect(page.getByText('Chapter One', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '1 / 2', exact: true })).toBeVisible();
  await expect(sentenceHighlight).toBeVisible();
  await expectHighlightInsidePage(sentenceHighlight, pageOne);

  await page.setViewportSize({ width: 600, height: 800 });

  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '1 / 2', exact: true })).toBeVisible();
  await expect(pageOne).toBeInViewport();
  await expect(page.getByText('Chapter One', { exact: true })).toBeVisible();
  await expect(sentenceHighlight).toBeVisible();
  await expectHighlightInsidePage(sentenceHighlight, pageOne);

  await page.setViewportSize({ width: 1280, height: 900 });

  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '1 / 2', exact: true })).toBeVisible();
  await expect(pageOne).toBeInViewport();
  await expect(page.getByText('Chapter One', { exact: true })).toBeVisible();
  await expect(sentenceHighlight).toBeVisible();
  await expectHighlightInsidePage(sentenceHighlight, pageOne);
});
