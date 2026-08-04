import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

test('anonymous user uploads PDF, EPUB, and TXT documents into the library', async ({ page }) => {
  await page.goto('/app');

  const privacyDialog = page.getByRole('dialog', {
    name: 'Privacy & Data Usage',
    exact: true,
  });
  const privacyContinue = privacyDialog.getByRole('button', {
    name: 'Continue',
    exact: true,
  });

  await expect(
    privacyDialog.getByRole('heading', {
      name: 'Privacy & Data Usage',
      exact: true,
    }),
  ).toBeVisible();
  await privacyDialog
    .getByRole('checkbox', {
      name: 'I have read and agree to the',
      exact: true,
    })
    .check();
  await privacyContinue.click();

  const backToSettings = page.getByRole('button', {
    name: 'Back to settings',
    exact: true,
  });
  await expect(backToSettings).toBeVisible();
  await backToSettings.click();

  const settingsDialog = page.getByRole('dialog', { name: /^Settings/ });
  const closeSettings = settingsDialog.getByRole('button', {
    name: 'Close dialog',
    exact: true,
  });
  await expect(closeSettings).toBeVisible();
  await closeSettings.click();
  await expect(settingsDialog).toBeHidden();

  const declineOptionalCookies = page.getByRole('button', {
    name: 'Decline Non-Essential',
    exact: true,
  });
  await declineOptionalCookies.click();
  await expect(declineOptionalCookies).toBeHidden();

  const chooserPromise = page.waitForEvent('filechooser');
  await page
    .getByText('Drop your file(s) here, or click to select', { exact: true })
    .click();
  const chooser = await chooserPromise;

  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([
    resolve('tests/files/sample.pdf'),
    resolve('tests/files/sample.epub'),
    resolve('tests/files/multilingual-sample.txt'),
  ]);

  await expect(page.getByText('Uploading', { exact: true })).toBeVisible();

  const pdfLink = page.getByRole('link', { name: 'sample.pdf', exact: true });
  const epubLink = page.getByRole('link', { name: 'sample.epub', exact: true });
  const textLink = page.getByRole('link', {
    name: 'multilingual-sample.txt',
    exact: true,
  });

  await expect(pdfLink).toBeVisible();
  await expect(epubLink).toBeVisible();
  await expect(textLink).toBeVisible();
  await expect(pdfLink).toHaveAttribute('href', /^\/pdf\/[a-f0-9]+$/);
  await expect(epubLink).toHaveAttribute('href', /^\/epub\/[a-f0-9]+$/);
  await expect(textLink).toHaveAttribute('href', /^\/html\/[a-f0-9]+$/);

  await expect(page.getByRole('button', { name: 'PDF 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'EPUB 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Text 1', exact: true })).toBeVisible();

  const libraryStatus = page.getByRole('status');
  await expect(libraryStatus).toContainText('1 PDF');
  await expect(libraryStatus).toContainText('1 EPUB');
  await expect(libraryStatus).toContainText('1 Text Doc');
  await expect(libraryStatus).toContainText('3 items');
});
