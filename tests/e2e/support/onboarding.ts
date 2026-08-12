import { expect, type Page } from '@playwright/test';

export async function enterAnonymousLibrary(page: Page) {
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
  const settingsPanel = page.getByTestId('settings-modal');
  await expect(closeSettings).toBeVisible();
  await expect(settingsPanel).not.toHaveAttribute('data-transition', '');
  await closeSettings.click();
  await expect(settingsPanel).toHaveCount(0);

  const declineOptionalCookies = page.getByRole('button', {
    name: 'Decline Non-Essential',
    exact: true,
  });
  await declineOptionalCookies.click();
  await expect(declineOptionalCookies).toBeHidden();
  await expect(
    page.getByText('Drop your file(s) here, or click to select', { exact: true }),
  ).toBeVisible();
}
