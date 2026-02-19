import { test, expect } from '@playwright/test';
import { setupTest, uploadFiles, ensureDocumentsListed, waitForDocumentListHintPersist, dispatchHtml5DragAndDrop } from './helpers';

test.describe('Document folders and hint persistence', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
  });

  // Utility to get the draggable row for a given filename (by link)
  const rowFor = (page: any, fileName: string) => {
    const link = page.getByRole('link', { name: new RegExp(fileName, 'i') }).first();
    // The draggable attribute lives on the row container ancestor
    return link.locator('xpath=ancestor::*[@draggable="true"][1]');
  };

  test('Folder creation via drag-and-drop with persistence', async ({ page }) => {
    // Upload three docs
    await uploadFiles(page, 'sample.pdf', 'sample.epub', 'sample.txt');
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub', 'sample.txt']);

    // Drag PDF onto EPUB to create a folder
    const pdfRow = rowFor(page, 'sample.pdf');
    const epubRow = rowFor(page, 'sample.epub');
    await dispatchHtml5DragAndDrop(page, pdfRow, epubRow);

    // Folder name dialog appears
    await expect(page.getByRole('heading', { name: 'Create New Folder' })).toBeVisible();
    const nameInput = page.getByPlaceholder('Enter folder name');
    await nameInput.fill('My Folder');
    await nameInput.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Create New Folder' })).toHaveCount(0);

    // Folder shows with both docs
    const folderHeading = page.getByRole('heading', { name: 'My Folder' });
    await expect(folderHeading).toBeVisible();

    // Scope checks inside the folder container
    const folderContainer = folderHeading.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " rounded-md ") and contains(concat(" ", normalize-space(@class), " "), " border ")][1]');
    await expect(folderContainer.getByRole('link', { name: /sample\.pdf/i })).toBeVisible();
    await expect(folderContainer.getByRole('link', { name: /sample\.epub/i })).toBeVisible();

    // Drag third doc (TXT) into folder
    const txtRow = rowFor(page, 'sample.txt');
    await dispatchHtml5DragAndDrop(page, txtRow, folderContainer);
    await expect(folderContainer.getByRole('link', { name: /sample\.txt/i })).toBeVisible();

    // Collapse folder and verify items are hidden
    const collapseBtn = folderContainer.getByRole('button', { name: 'Collapse folder' });
    await collapseBtn.scrollIntoViewIfNeeded();
    await expect(collapseBtn).toBeVisible();
    await collapseBtn.click();
    await expect(folderContainer.getByRole('button', { name: 'Expand folder' })).toBeVisible();
    await expect(folderContainer.getByRole('link', { name: /sample\.pdf/i })).toHaveCount(0);
    await expect(folderContainer.getByRole('link', { name: /sample\.epub/i })).toHaveCount(0);
    await expect(folderContainer.getByRole('link', { name: /sample\.txt/i })).toHaveCount(0);

    // Reload and verify persisted folder with collapsed state and documents
    await page.reload();
    await page.waitForLoadState('networkidle');
    const folderHeadingAfter = page.getByRole('heading', { name: 'My Folder' });
    await expect(folderHeadingAfter).toBeVisible();
    const folderContainerAfter = folderHeadingAfter.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " rounded-md ") and contains(concat(" ", normalize-space(@class), " "), " border ")][1]');

    // Still collapsed after reload
    await expect(folderContainerAfter.getByRole('button', { name: 'Expand folder' })).toBeVisible();
    await expect(folderContainerAfter.getByRole('link', { name: /sample\.pdf/i })).toHaveCount(0);
    await expect(folderContainerAfter.getByRole('link', { name: /sample\.epub/i })).toHaveCount(0);
    await expect(folderContainerAfter.getByRole('link', { name: /sample\.txt/i })).toHaveCount(0);

    // Expand and verify all three documents visible
    const expandBtn = folderContainerAfter.getByRole('button', { name: 'Expand folder' });
    await expandBtn.scrollIntoViewIfNeeded();
    await expect(expandBtn).toBeVisible();
    await expandBtn.click();
    await expect(folderContainerAfter.getByRole('link', { name: /sample\.pdf/i })).toBeVisible();
    await expect(folderContainerAfter.getByRole('link', { name: /sample\.epub/i })).toBeVisible();
    await expect(folderContainerAfter.getByRole('link', { name: /sample\.txt/i })).toBeVisible();
  });

  test('Dismiss “Drag files to make folders” hint persists after reload', async ({ page }) => {
    // Need at least 2 docs for the hint to appear
    await uploadFiles(page, 'sample.pdf', 'sample.epub');
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub']);

    const hint = page.getByText('Drag files on top of each other to make folders');
    await expect(hint).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss hint' }).click();

    // Hint should disappear
    await expect(hint).toHaveCount(0);

    // Ensure the dismissal has been persisted to IndexedDB before reloading
    await waitForDocumentListHintPersist(page, false);

    // Reload and ensure it remains dismissed
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Drag files on top of each other to make folders')).toHaveCount(0);
  });
});
