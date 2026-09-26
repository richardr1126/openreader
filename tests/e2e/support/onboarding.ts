import { expect, type Page } from '@playwright/test';

export async function closeChangelog(page: Page) {
  const changelogDialog = page.getByRole('dialog', { name: 'Changelog', exact: true });
  const changelogPanel = page.getByTestId('changelog-modal');
  const closeButton = changelogDialog.getByRole('button', { name: 'Close changelog', exact: true });
  await expect(changelogPanel).toBeVisible();
  await expect(closeButton).toBeVisible();

  const [panelBox, closeBox] = await Promise.all([
    changelogPanel.boundingBox(),
    closeButton.boundingBox(),
  ]);
  expect(panelBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.x).toBeGreaterThan(panelBox!.x + panelBox!.width / 2);

  await closeButton.click();
  await expect.poll(() => changelogDialog.evaluateAll((dialogs) => (
    dialogs.length === 0 || getComputedStyle(dialogs[0]).pointerEvents === 'none'
  ))).toBe(true);
}

/**
 * A fresh browser context shows the consent banner shortly after load, fixed
 * over the bottom of the page. Settle it before using controls it can cover.
 */
export async function declineOptionalCookies(page: Page) {
  const decline = page.getByRole('button', { name: 'Decline Non-Essential', exact: true });
  await decline.click();
  await expect(decline).toBeHidden();
}

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

  await closeChangelog(page);

  await declineOptionalCookies(page);
  await expect(
    page.getByText('Drop your file(s) here, or click to select', { exact: true }),
  ).toBeVisible();
}
