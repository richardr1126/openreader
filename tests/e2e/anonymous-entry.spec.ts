import { expect, test } from '@playwright/test';

test('anonymous visitor completes first-run entry and reaches the library', async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto('/');

  await expect(
    page.getByRole('heading', {
      name: 'Hear every document, highlighted word by word.',
      exact: true,
    }),
  ).toBeVisible();

  const declineOptionalCookies = page.getByRole('button', {
    name: 'Decline Non-Essential',
    exact: true,
  });
  await declineOptionalCookies.click();
  await expect(declineOptionalCookies).toBeHidden();

  await page.getByRole('link', { name: 'Open the reader', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30_000 });

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
  ).toBeVisible({ timeout: 30_000 });
  await expect(privacyContinue).toBeDisabled();
  await privacyDialog
    .getByRole('checkbox', {
      name: 'I have read and agree to the',
      exact: true,
    })
    .check();
  await expect(privacyContinue).toBeEnabled();
  await privacyContinue.click();

  const changelogDialog = page.getByRole('dialog', { name: 'Changelog', exact: true });
  const changelogPanel = page.getByTestId('changelog-modal');
  await expect(changelogPanel).toBeVisible();
  await changelogDialog.getByRole('button', { name: 'Close changelog', exact: true }).click();
  await expect(changelogPanel).toHaveCount(0);

  await expect(page.getByRole('heading', { name: 'OpenReader', exact: true })).toBeVisible();
  await expect(
    page.getByText('Drop your file(s) here, or click to select', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('PDF, EPUB, TXT, MD, or DOCX files are accepted', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText('0 items');

  const settingsTrigger = page.getByRole('link', { name: 'Settings', exact: true });
  await settingsTrigger.focus();
  await expect(settingsTrigger).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/app\/settings$/);
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Appearance', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Documents', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Changelog', exact: true }).first().click();
  await expect(changelogPanel).toBeVisible();
  await changelogDialog.getByRole('button', { name: 'Close changelog', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Appearance', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  const hasHorizontalOverflow = await page.getByTestId('settings-page').evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  const closeSettings = page.getByRole('link', { name: 'Close settings', exact: true });
  await closeSettings.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/app$/);
});
