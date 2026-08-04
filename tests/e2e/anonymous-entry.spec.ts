import { expect, test } from '@playwright/test';

test('anonymous visitor completes first-run entry and reaches the library', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', {
      name: 'Hear every document, highlighted word by word.',
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Open the reader', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);

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
  await expect(privacyContinue).toBeDisabled();
  await privacyDialog
    .getByRole('checkbox', {
      name: 'I have read and agree to the',
      exact: true,
    })
    .check();
  await expect(privacyContinue).toBeEnabled();
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

  await expect(page.getByRole('heading', { name: 'OpenReader', exact: true })).toBeVisible();
  await expect(
    page.getByText('Drop your file(s) here, or click to select', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('PDF, EPUB, TXT, MD, or DOCX files are accepted', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText('0 items');
});
