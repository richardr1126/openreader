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
  const iosBanner = page.getByRole('complementary', { name: 'OpenReader for iOS beta' });
  await expect(iosBanner).toBeVisible();
  await expect(iosBanner.getByRole('link', { name: 'Join iOS beta' })).toHaveAttribute(
    'href',
    'https://testflight.apple.com/join/eJTYjDwV',
  );
  await iosBanner.getByRole('button', { name: 'Dismiss iOS beta banner' }).click();
  await expect(iosBanner).toBeHidden();

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

  const initialFolderButton = page.getByRole('button', {
    name: 'Reading List 2',
    exact: true,
  });
  await expect(folderDialog).toBeHidden();
  await expect(initialFolderButton).toBeVisible();
  await expect(textLink).toBeVisible();
  await expect(epubLink).toBeVisible();
  await expect(pdfLink).toBeHidden();

  // Uploads started while a folder is selected belong to that folder immediately.
  await page.getByRole('button', { name: 'Add Documents', exact: true }).click();
  const uploadDialog = page.getByRole('dialog', { name: 'Add Documents', exact: true });
  const chooserPromise = page.waitForEvent('filechooser');
  await uploadDialog.getByText('Drop your file(s) here, or click to select', { exact: true }).click();
  await (await chooserPromise).setFiles(resolve('tests/files/sample.md'));
  const markdownLink = page.getByRole('link', { name: 'sample.md', exact: true });
  await expect(markdownLink).toBeVisible();
  const folderButton = page.getByRole('button', { name: 'Reading List 3', exact: true });
  await expect(folderButton).toBeVisible();

  await page.reload();

  await expect(folderButton).toBeVisible();
  await expect(textLink).toBeVisible();
  await expect(epubLink).toBeVisible();
  await expect(markdownLink).toBeVisible();
  await expect(pdfLink).toBeHidden();
  await expect(iosBanner).toBeHidden();
  await expect(page.getByRole('status')).toContainText('3 items');
});
