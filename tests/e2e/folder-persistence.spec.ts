import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user creates a folder by dragging documents together and keeps it after reload', async ({ page }) => {
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, [
    resolve('tests/files/multilingual-sample.txt'),
    resolve('tests/files/sample.epub'),
    resolve('tests/files/sample.pdf'),
  ]);

  const textLink = page.getByRole('link', {
    name: 'multilingual-sample.txt',
    exact: true,
  });
  const epubLink = page.getByRole('link', { name: 'sample.epub', exact: true });
  const pdfLink = page.getByRole('link', { name: 'sample.pdf', exact: true });
  await expect(textLink).toBeVisible();
  await expect(epubLink).toBeVisible();
  await expect(pdfLink).toBeVisible();
  await expect(page.getByRole('button', { name: 'All Documents 3', exact: true })).toBeVisible();
  const folderHint = page.getByText(
    'Drag files onto each other to make folders. Drop into the sidebar to move.',
    { exact: true },
  );
  await expect(folderHint).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss hint', exact: true }).click();
  await expect(folderHint).toBeHidden();

  const textTile = page.locator('[data-doc-tile]').filter({ has: textLink });
  const epubTile = page.locator('[data-doc-tile]').filter({ has: epubLink });
  const textBox = await textTile.boundingBox();
  const epubBox = await epubTile.boundingBox();
  expect(textBox).not.toBeNull();
  expect(epubBox).not.toBeNull();
  if (!textBox || !epubBox) throw new Error('Document cards must have visible drag geometry');

  const start = {
    x: textBox.x + textBox.width / 2,
    y: textBox.y + textBox.height / 2,
  };
  const end = {
    x: epubBox.x + epubBox.width / 2,
    y: epubBox.y + epubBox.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // The shared touch/mouse backend arms mouse input on its next task. Holding
  // briefly models a physical press before movement instead of streaming an
  // impossible down-and-drag sequence inside the same browser task.
  await page.waitForTimeout(25);
  await page.mouse.move(start.x + 16, start.y, { steps: 4 });
  await expect(textTile).toHaveAttribute('aria-selected', 'true');
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await expect(epubTile).toHaveAttribute('data-drop-target', 'true');
  await page.mouse.up();

  const folderDialog = page.getByRole('dialog', {
    name: 'Create New Folder',
    exact: true,
  });
  const folderName = folderDialog.getByPlaceholder('Enter folder name', { exact: true });
  await expect(folderName).toBeFocused();
  await folderName.fill('Reading List');
  await folderName.press('Enter');

  const folderButton = page.getByRole('button', {
    name: 'Reading List 2',
    exact: true,
  });
  await expect(folderDialog).toBeHidden();
  await expect(folderButton).toBeVisible();
  await expect(textLink).toBeVisible();
  await expect(epubLink).toBeVisible();
  await expect(pdfLink).toBeHidden();

  await page.reload();

  await expect(folderButton).toBeVisible();
  await expect(textLink).toBeVisible();
  await expect(epubLink).toBeVisible();
  await expect(pdfLink).toBeHidden();
  await expect(folderHint).toBeHidden();
  await expect(page.getByRole('status')).toContainText('3 items');
});
