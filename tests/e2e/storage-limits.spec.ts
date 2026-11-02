import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('a guest blocked by storage can free space or create an account', async ({ page }) => {
  await enterAnonymousLibrary(page);
  await page.route('**/api/v1/uploads', (route) => route.fulfill({ status: 429, json: { error: {
    code: 'GUEST_STORAGE_LIMIT_REACHED', message: 'Guest storage limit reached. Free space in Storage (/app/settings?section=storage). You can also create an account (/signup).',
  } } }));
  await uploadLibraryFiles(page, resolve('tests/files/multilingual-sample.txt'), { waitForLibraryEntries: false });
  const failure = page.getByRole('alert').filter({ hasText: 'Guest storage limit reached.' });
  await expect(failure.getByRole('link', { name: 'Create an account', exact: true })).toHaveAttribute('href', '/signup');
  await failure.getByRole('link', { name: 'Free space in Storage', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/settings\?section=storage$/);
  await expect(page.getByText('Total storage', { exact: true })).toBeVisible();
});
