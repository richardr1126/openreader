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

  const changelogDialog = page.getByRole('dialog', { name: 'Changelog', exact: true });
  const changelogPanel = page.getByTestId('changelog-modal');
  await expect(changelogPanel).toBeVisible();
  await changelogDialog.getByRole('button', { name: 'Close changelog', exact: true }).click();

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
