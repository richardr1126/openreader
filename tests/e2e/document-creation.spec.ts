import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';

test('creates Markdown through the document API and reads its saved content', async ({ page }) => {
  await enterAnonymousLibrary(page);
  await page.getByRole('button', { name: 'Add Documents', exact: true }).click();
  await page.getByRole('button', { name: 'Create Document', exact: true }).click();
  const text = '# Created from text\n\nA custom document should remain readable after returning to the library.';
  await page.getByPlaceholder('Document title (e.g. notes)').fill('Custom document');
  await page.getByRole('textbox').last().fill(text);
  const created = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/documents');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const id = createHash('sha256').update(text).digest('hex');
  expect(await response.json()).toMatchObject({ id, name: 'Custom document.md', status: 'ready' });
  const document = page.getByRole('link', { name: 'Custom document.md', exact: true });
  await expect(document).toHaveAttribute('href', `/html/${id}`);
  await document.click();
  await expect(page.getByRole('heading', { name: 'Created from text', exact: true })).toBeVisible();
  await expect(page.getByText('A custom document should remain readable after returning to the library.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('link', { name: 'Custom document.md', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Custom document.md', exact: true })).toBeVisible();
});
