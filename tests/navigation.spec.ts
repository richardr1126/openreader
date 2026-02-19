import { test, expect } from '@playwright/test';
import {
  setupTest,
  uploadFiles,
  ensureDocumentsListed,
  clickDocumentLink,
  expectViewerForFile,
  uploadAndDisplay,
  playTTSAndWaitForASecond,
  expectProcessingTransition,
} from './helpers';

// Single-spec helpers kept local to avoid cluttering shared helpers:
async function navigateToPdfPageViaNavigator(page: any, targetPage: number) {
  // Navigator popover shows "X / Y"
  const navTrigger = page.getByRole('button', { name: /\d+\s*\/\s*\d+/ });
  await expect(navTrigger).toBeVisible({ timeout: 10000 });
  await navTrigger.click();

  const input = page.getByLabel('Page number');
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill(String(targetPage));
  await input.press('Enter');
}

async function countRenderedPdfPages(page: any): Promise<number> {
  return await page.locator('.react-pdf__Page').count();
}

async function triggerViewportResize(page: any, width: number, height: number) {
  await page.setViewportSize({ width, height });
}

test.describe('Document link navigation by type', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
  });

  test('navigates to /pdf, /epub, /html and renders correct viewers', async ({ page }) => {
    // Upload documents
    await uploadFiles(page, 'sample.pdf', 'sample.epub', 'sample.txt');

    // Ensure links exist
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub', 'sample.txt']);

    // PDF
    await clickDocumentLink(page, 'sample.pdf');
    await expectViewerForFile(page, 'sample.pdf');
    await page.goBack();

    // EPUB
    await clickDocumentLink(page, 'sample.epub');
    await expectViewerForFile(page, 'sample.epub');
    await page.goBack();

    // TXT (HTML viewer)
    await clickDocumentLink(page, 'sample.txt');
    await expectViewerForFile(page, 'sample.txt');
  });
});

test.describe('PDF view modes and Navigator', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
  });

  test('switches Single/Dual/Scroll modes and uses Navigator to change page', async ({ page }) => {
    test.setTimeout(60_000);
    // Open PDF viewer
    await uploadAndDisplay(page, 'sample.pdf');
    await expect(page.locator('.react-pdf__Document')).toBeVisible({ timeout: 15000 });

    // Open document settings (page-level settings)
    await page.getByRole('button', { name: 'Open settings' }).click();

    // The mode Listbox initially shows "Single Page" by default; switch to "Two Pages"
    await page.getByRole('button', { name: /Single Page|Two Pages|Continuous Scroll/i }).click();
    await page.getByRole('option', { name: 'Two Pages' }).click();
    await page.getByRole('button', { name: 'Close' }).click();

    // Expect dual-page rendering (sample.pdf has >= 2 pages)
    const dualCount = await countRenderedPdfPages(page);
    expect(dualCount).toBeGreaterThanOrEqual(2);

    // Switch to Continuous Scroll
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('button', { name: /Single Page|Two Pages|Continuous Scroll/i }).click();
    await page.getByRole('option', { name: 'Continuous Scroll' }).click();
    await page.getByRole('button', { name: 'Close' }).click();

    // Expect continuous scroll renders at least as many pages as dual mode
    const scrollCount = await countRenderedPdfPages(page);
    expect(scrollCount).toBeGreaterThanOrEqual(dualCount);

    // Use Navigator to go to a page (clamps to last if too large)
    await navigateToPdfPageViaNavigator(page, 999);
    // Navigator jump is configured to pause; ensure Play is visible then resume
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Play' }).click();
    await expectProcessingTransition(page);
  });
});

test.describe('EPUB resize pauses TTS', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
  });

  test('resizing viewport pauses playback and play resumes after', async ({ page }) => {
    // Start playback on EPUB
    await playTTSAndWaitForASecond(page, 'sample.epub');

    // Trigger a significant viewport resize to fire useEPUBResize
    await triggerViewportResize(page, 1200, 900);
    await page.waitForTimeout(750); // allow resize flag to propagate
    await triggerViewportResize(page, 900, 700);
    await page.waitForTimeout(750);

    // After resize, playback should have paused (Play button visible)
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 15000 });

    // Resume playback and ensure processing -> playing
    await page.getByRole('button', { name: 'Play' }).click();
    await expectProcessingTransition(page);
  });
});
