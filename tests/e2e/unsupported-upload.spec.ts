import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

test('anonymous user receives useful feedback for an unsupported file', async ({ page }) => {
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
  await chooser.setFiles(resolve('tests/files/unsupported.xyz'));

  await expect(
    page.getByRole('alert').filter({ hasText: 'unsupported.xyz is not supported.' }),
  ).toHaveText('unsupported.xyz is not supported. Choose a PDF, EPUB, TXT, MD, or DOCX file.');
  await expect(
    page.getByRole('link', { name: 'unsupported.xyz', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('0 items');
});
