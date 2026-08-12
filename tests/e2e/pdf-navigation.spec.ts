import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user navigates PDF pages, zoom, and page modes', async ({ page }) => {
  test.setTimeout(60_000);
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, resolve('tests/files/sample.pdf'));

  const pdfLink = page.getByRole('link', { name: 'sample.pdf', exact: true });
  await expect(pdfLink).toBeVisible();
  await pdfLink.click();

  await expect(page).toHaveURL(/\/pdf\/[a-f0-9]+$/);
  await expect(page.getByRole('heading', { name: 'sample.pdf', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const previousPage = page.getByRole('button', { name: 'Previous page', exact: true });
  const nextPage = page.getByRole('button', { name: 'Next page', exact: true });
  const pageOne = page.getByRole('region', { name: 'PDF page 1', exact: true });
  const pageTwo = page.getByRole('region', { name: 'PDF page 2', exact: true });

  await expect(pageOne).toBeInViewport();
  await expect(previousPage).toBeDisabled();
  await nextPage.click();
  await expect(page.getByText('Chapter Two', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '2 / 2', exact: true })).toBeVisible();
  await expect(nextPage).toBeDisabled();

  await page.getByRole('button', { name: '2 / 2', exact: true }).click();
  const pageNumber = page.getByRole('textbox', { name: 'Page number', exact: true });
  await pageNumber.fill('1');
  await pageNumber.press('Enter');
  await expect(pageNumber).toBeHidden();
  await expect(page.getByRole('button', { name: '1 / 2', exact: true })).toBeFocused();
  await expect(page.getByText('Chapter One', { exact: true })).toBeVisible();

  const zoomControls = page.getByLabel('Zoom controls', { exact: true });
  await zoomControls.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(zoomControls).toContainText('110%');
  await zoomControls.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(zoomControls).toContainText('100%');

  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const readerSettings = page.getByRole('dialog', { name: 'Document settings', exact: true });
  await expect(readerSettings.getByRole('radio', { name: 'Single Page', exact: true })).toBeChecked();
  await readerSettings.getByRole('radio', { name: 'Two Pages', exact: true }).click();
  await expect(readerSettings.getByRole('radio', { name: 'Two Pages', exact: true })).toBeChecked();
  await readerSettings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(pageOne).toBeInViewport();
  await expect(pageTwo).toBeInViewport();

  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await readerSettings.getByRole('radio', { name: 'Continuous Scroll', exact: true }).click();
  await expect(
    readerSettings.getByRole('radio', { name: 'Continuous Scroll', exact: true }),
  ).toBeChecked();
  await readerSettings.getByRole('button', { name: 'Close', exact: true }).click();

  await expect(pageOne).toBeInViewport();
  await nextPage.click();
  await expect(page.getByRole('button', { name: '2 / 2', exact: true })).toBeVisible();
  await expect(pageTwo).toBeInViewport();
  await expect(page.getByText('Chapter Two', { exact: true })).toBeVisible({ timeout: 15_000 });

  await pageTwo.hover();
  await page.mouse.wheel(0, -10_000);
  await expect(page.getByRole('button', { name: '1 / 2', exact: true })).toBeVisible();
  await expect(pageOne).toBeInViewport();

  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('link', { name: 'sample.pdf', exact: true })).toBeVisible();
});
