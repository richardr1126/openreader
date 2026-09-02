import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user cancels and confirms document deletion', async ({ page }) => {
  test.setTimeout(60_000);
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, resolve('tests/files/sample.md'));

  const documentLink = page.getByRole('link', { name: 'sample.md', exact: true });
  const deleteButton = page.getByRole('button', {
    name: 'Delete sample.md',
    exact: true,
  });
  await expect(documentLink).toBeVisible();
  await expect(page.getByRole('button', { name: 'All Documents 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Text 1', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('1 item');

  await deleteButton.click();
  const confirmation = page.getByRole('dialog', { name: 'Delete Document', exact: true });
  const confirmationHeading = confirmation.getByRole('heading', {
    name: 'Delete Document',
    exact: true,
  });
  const confirmationPanel = page.getByTestId('confirm-dialog-panel');
  await expect(confirmationHeading).toBeVisible();
  await expect(confirmation).toContainText('Are you sure you want to delete sample.md?');
  await expect(
    confirmation.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await expect(confirmationPanel).not.toHaveAttribute('data-transition', '');

  await page.keyboard.press('Escape');
  await expect(confirmationHeading).toBeHidden({ timeout: 15_000 });
  await expect(documentLink).toBeVisible();
  await expect(deleteButton).toBeFocused();

  await deleteButton.click();
  await expect(confirmationHeading).toBeVisible();
  await expect(
    confirmation.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await expect(confirmationPanel).not.toHaveAttribute('data-transition', '');
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(documentLink).toBeHidden();
  await expect(page.getByRole('button', { name: 'All Documents', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('0 items');
  await expect(
    page.getByText('Drop your file(s) here, or click to select', { exact: true }),
  ).toBeVisible();
  await expect(confirmationHeading).toBeHidden({ timeout: 15_000 });
});
