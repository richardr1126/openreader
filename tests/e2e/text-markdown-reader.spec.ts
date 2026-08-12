import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user reads literal text and semantic Markdown', async ({ page }) => {
  test.setTimeout(45_000);
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, [
    resolve('tests/files/multilingual-sample.txt'),
    resolve('tests/files/sample.md'),
  ]);

  const textLink = page.getByRole('link', {
    name: 'multilingual-sample.txt',
    exact: true,
  });
  const markdownLink = page.getByRole('link', { name: 'sample.md', exact: true });
  await expect(textLink).toBeVisible();
  await expect(markdownLink).toBeVisible();

  await textLink.click();
  await expect(page).toHaveURL(/\/html\/[a-f0-9]+$/);
  await expect(
    page.getByRole('heading', { name: 'multilingual-sample.txt', exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(
      /English\s+OpenReader should split this sentence correctly\. This is the second sentence\./,
    ),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'English', exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Playback position', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.getByRole('link', { name: 'sample.md', exact: true }).click();

  await expect(page).toHaveURL(/\/html\/[a-f0-9]+$/);
  await expect(page.getByRole('heading', { name: 'sample.md', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole('heading', { name: 'Sample Markdown', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Section One', exact: true, level: 2 }),
  ).toBeVisible();
  const markdownList = page.getByRole('list');
  await expect(markdownList).toBeVisible();
  await expect(markdownList.getByText('Item 1', { exact: true })).toBeVisible();
  await expect(markdownList.getByText('Item 2', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'OpenAI', exact: true })).toHaveAttribute(
    'href',
    'https://www.openai.com',
  );
  await expect(page.getByText("console.log('hello markdown');", { exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Playback position', exact: true })).toBeVisible();
});
