import { test, expect } from '@playwright/test';
import {
  setupTest,
  uploadFiles,
  ensureDocumentsListed,
  uploadAndDisplay,
  expectProcessingTransition,
} from './helpers';

test.describe('Accessibility smoke', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
  });

  test('dropzone input and hint text are accessible', async ({ page }) => {
    // Input is present and visible
    await expect(page.locator('input[type="file"]')).toBeVisible({ timeout: 10000 });

    // Hint text present (supports compact or default variants)
    await expect(
      page.getByText(/Drop your file\(s\) here|Drop files or click|Drop your file\(s\) here, or click to select/i)
    ).toBeVisible();
  });

  test('document links have roles and accessible names', async ({ page }) => {
    await uploadFiles(page, 'sample.pdf', 'sample.epub', 'sample.txt');
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub', 'sample.txt']);

    await expect(page.getByRole('link', { name: /sample\.pdf/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /sample\.epub/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /sample\.txt/i })).toBeVisible();
  });

  test('ConfirmDialog exposes role=dialog with title and actions', async ({ page }) => {
    await uploadFiles(page, 'sample.pdf');
    await ensureDocumentsListed(page, ['sample.pdf']);

    // Open the confirm dialog by clicking the row delete button
    await page.getByRole('button', { name: 'Delete document' }).first().click();

    // Title and dialog role visible
    const heading = page.getByRole('heading', { name: 'Delete Document' });
    await expect(heading).toBeVisible({ timeout: 10000 });
    const dialog = heading.locator('xpath=ancestor::*[@role="dialog"][1]');
    await expect(dialog).toBeVisible();

    // Has a destructive action (Delete)
    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeVisible();

    // Close with Escape to avoid deleting test data
    await page.keyboard.press('Escape');
  });

  test('TTS controls expose aria labels and are keyboard focusable', async ({ page }) => {
    await uploadAndDisplay(page, 'sample.pdf');

    // TTS bar present
    const ttsbar = page.locator('[data-app-ttsbar]');
    await expect(ttsbar).toBeVisible();

    // Verify control labels
    const backBtn = page.getByRole('button', { name: 'Skip backward' });
    const playBtn = page.getByRole('button', { name: 'Play' });
    const fwdBtn = page.getByRole('button', { name: 'Skip forward' });

    await expect(backBtn).toBeVisible();
    await expect(playBtn).toBeVisible();
    await expect(fwdBtn).toBeVisible();

    // Keyboard focus checks
    await page.focus('button[aria-label="Skip backward"]');
    await expect(backBtn).toBeFocused();

    await page.focus('button[aria-label="Play"]');
    await expect(playBtn).toBeFocused();

    await page.focus('button[aria-label="Skip forward"]');
    await expect(fwdBtn).toBeFocused();

    // Toggle play and verify aria-label swap to Pause, then back to Play
    await playBtn.click();
    await expectProcessingTransition(page);
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 10000 });
  });
});
