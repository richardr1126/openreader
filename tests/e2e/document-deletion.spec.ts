import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

test('anonymous user cancels and confirms document deletion', async ({ page }) => {
  await page.goto('/app');

  const privacyDialog = page.getByRole('dialog', {
    name: 'Privacy & Data Usage',
    exact: true,
  });
  await privacyDialog
    .getByRole('checkbox', {
      name: 'I have read and agree to the',
      exact: true,
    })
    .check();
  await privacyDialog.getByRole('button', { name: 'Continue', exact: true }).click();

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
  await chooser.setFiles(resolve('tests/files/sample.md'));

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
  await expect(confirmationHeading).toBeVisible();
  await expect(confirmation).toContainText('Are you sure you want to delete sample.md?');

  await page.keyboard.press('Escape');
  await expect(confirmationHeading).toBeHidden();
  await expect(documentLink).toBeVisible();
  await expect(deleteButton).toBeFocused();

  await deleteButton.click();
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
