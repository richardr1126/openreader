import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';

test('an upload link opens Add Documents into its folder, and the file lands there', async ({ page }) => {
  await enterAnonymousLibrary(page);
  const created = await page.request.post('/api/v1/folders', { data: { name: 'Papers' } });
  expect(created.status()).toBe(201);
  const folder = await created.json() as { id: string };

  await page.goto(`/app/upload/${folder.id}`);
  await expect(page.getByRole('heading', { name: 'Add Documents' })).toBeVisible();
  await expect(page).toHaveURL(/\/app$/);
  const dialog = page.getByRole('dialog', { name: 'Add Documents' });

  const chooser = page.waitForEvent('filechooser');
  await dialog.getByText('Drop your file(s) here, or click to select', { exact: true }).click();
  await (await chooser).setFiles(resolve('tests/files/sample.pdf'));
  await expect(page.getByRole('link', { name: 'sample.pdf', exact: true })).toBeVisible({ timeout: 30_000 });

  await expect(page.getByRole('button', { name: 'Papers 1', exact: true })).toBeVisible();
});
