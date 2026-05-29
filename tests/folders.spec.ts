import { test, expect, type Page } from '@playwright/test';
import {
  setupTest,
  uploadFiles,
  ensureDocumentsListed,
  waitForDocumentListHintPersist,
  dispatchHtml5DragAndDrop,
  expectDocumentListed,
  expectNoDocumentLink,
} from './helpers';

test.describe('Document folders and hint persistence', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
  });

  // Utility to get the draggable row for a given filename (by link)
  const rowFor = (page: Page, fileName: string) => {
    const link = page.getByRole('link', { name: new RegExp(fileName, 'i') }).first();
    // The draggable attribute lives on the row container ancestor
    return link.locator('xpath=ancestor::*[@draggable="true"][1]');
  };

  const folderRow = (page: Page, folderName: string) =>
    page.getByRole('button', { name: new RegExp(`^${folderName}\\b`, 'i') }).first();

  const allDocumentsRow = (page: Page) =>
    page.getByRole('button', { name: /^All Documents\b/i }).first();

  test('Folder creation via drag-and-drop with persistence', async ({ page }) => {
    // Upload four docs (one stays outside folder to verify filtering)
    await uploadFiles(page, 'sample.pdf', 'sample.epub', 'sample.txt', 'sample.md');
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub', 'sample.txt', 'sample.md']);

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

    // Sidebar folder row exists and folder becomes selected (content filtered to folder docs)
    const myFolderRow = folderRow(page, 'My Folder');
    await expect(myFolderRow).toBeVisible();
    await expectDocumentListed(page, 'sample.pdf');
    await expectDocumentListed(page, 'sample.epub');
    await expectNoDocumentLink(page, 'sample.txt');
    await expectNoDocumentLink(page, 'sample.md');

    // Switch to all documents and drag TXT into sidebar folder row
    await allDocumentsRow(page).click();
    const txtRow = rowFor(page, 'sample.txt');
    await dispatchHtml5DragAndDrop(page, txtRow, myFolderRow);
    await expectDocumentListed(page, 'sample.txt');
    await expectNoDocumentLink(page, 'sample.md');

    // Reload and verify persisted folder + membership
    await page.reload();
    await page.waitForLoadState('networkidle');
    const myFolderRowAfter = folderRow(page, 'My Folder');
    await expect(myFolderRowAfter).toBeVisible();
    await myFolderRowAfter.click();
    await expectDocumentListed(page, 'sample.pdf');
    await expectDocumentListed(page, 'sample.epub');
    await expectDocumentListed(page, 'sample.txt');
    await expectNoDocumentLink(page, 'sample.md');
  });

  test('Dismiss “Drag files to make folders” hint persists after reload', async ({ page }) => {
    // Need at least 2 docs for the hint to appear
    await uploadFiles(page, 'sample.pdf', 'sample.epub');
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub']);

    const hint = page.getByText('Drag files onto each other to make folders. Drop into the sidebar to move.');
    await expect(hint).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss hint' }).click();

    // Hint should disappear
    await expect(hint).toHaveCount(0);

    // Ensure the dismissal has been persisted to IndexedDB before reloading
    await waitForDocumentListHintPersist(page, false);

    // Reload and ensure it remains dismissed
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Drag files onto each other to make folders. Drop into the sidebar to move.')).toHaveCount(0);
  });
});
