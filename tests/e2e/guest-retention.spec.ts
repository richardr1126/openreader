import { expect, test, type Page } from '@playwright/test';
import { closeChangelog, declineOptionalCookies } from './support/onboarding';

/** Enabling the task for real would reach every guest in the parallel suite. */
async function retainGuestsFor(page: Page, days: () => number) {
  await page.route('**/api/user/state/onboarding', async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { onboarding: Record<string, unknown> };
    await route.fulfill({ response, json: { onboarding: { ...body.onboarding, guestRetentionDays: days() } } });
  });
}

test('a guest is told once how long idle data is kept, and again when the period shrinks', async ({ page }) => {
  let days = 30;
  await retainGuestsFor(page, () => days);
  await page.goto('/app');

  const privacy = page.getByRole('dialog', { name: 'Privacy & Data Usage', exact: true });
  await privacy.getByRole('checkbox', { name: 'I have read and agree to the', exact: true }).check();
  await privacy.getByRole('button', { name: 'Continue', exact: true }).click();

  const notice = (count: number) => page.getByRole('dialog', {
    name: `Guest data is deleted after ${count} days without use`,
    exact: true,
  });
  await expect(notice(30).getByText("Generated audio isn't transferred.", { exact: false })).toBeVisible();
  await notice(30).getByRole('button', { name: 'Continue as guest', exact: true }).click();
  await expect(notice(30)).toBeHidden();
  await closeChangelog(page);
  await declineOptionalCookies(page);

  await page.reload();
  await expect(page.getByText('Drop your file(s) here, or click to select', { exact: true })).toBeVisible();
  await expect(notice(30)).toBeHidden();

  days = 14;
  await page.reload();
  await notice(14).getByRole('button', { name: 'Create an account', exact: true }).click();
  await expect(page).toHaveURL(/\/signup$/);
});
