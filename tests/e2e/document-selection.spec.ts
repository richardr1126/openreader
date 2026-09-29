import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user selects documents, moves them into a folder, and deletes in bulk', async ({ page }) => {
  test.setTimeout(90_000);
  await enterAnonymousLibrary(page);
  await uploadLibraryFiles(page, [
    resolve('tests/files/sample.md'),
    resolve('tests/files/sample.pdf'),
    resolve('tests/files/sample.epub'),
  ]);

  const bar = page.getByRole('toolbar', { name: 'Selected documents' });
  await expect(bar).toBeHidden();

  await page.getByRole('checkbox', { name: 'Select sample.md', exact: true }).click();
  await expect(bar).toContainText('1 selected');

  // With a selection active, a plain click selects instead of opening.
  await page.getByRole('link', { name: 'sample.pdf', exact: true }).click();
  await expect(bar).toContainText('2 selected');
  await expect(page).toHaveURL(/\/app/);

  await bar.getByRole('button', { name: 'Move', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click();
  await page.getByRole('textbox').fill('Reading list');
  await page.keyboard.press('Enter');
  await expect(bar).toBeHidden();
  await expect(page.getByRole('button', { name: 'Reading list 2', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'All Documents 3', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select sample.epub', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();

  await page.keyboard.press('ControlOrMeta+a');
  await expect(bar).toContainText('3 selected');
  await bar.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete Documents', exact: true });
  await expect(confirmation).toContainText('these 3 documents');
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'items' })).toContainText('0 items');
  await expect(bar).toBeHidden();
});
