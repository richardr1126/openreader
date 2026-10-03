import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';

// Results come from a live Gutendex server and gutenberg.org, which a test run
// cannot depend on, so this covers reaching the catalog and stops at its search.
test('the Project Gutenberg catalog is reachable from Add Documents', async ({ page }) => {
  await enterAnonymousLibrary(page);

  await page.getByRole('button', { name: 'Add Documents', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Documents', exact: true });
  await dialog.getByRole('button', { name: 'Project Gutenberg', exact: true }).click();

  await expect(dialog.getByRole('searchbox', { name: 'Search Project Gutenberg' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Project Gutenberg', exact: true })).toHaveAttribute('href', 'https://www.gutenberg.org');
});
