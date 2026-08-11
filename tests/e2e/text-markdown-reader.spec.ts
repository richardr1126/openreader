import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

test('anonymous user reads literal text and semantic Markdown', async ({ page }) => {
  test.setTimeout(45_000);
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

  const backToSettings = page.getByRole('button', {
    name: 'Back to settings',
    exact: true,
  });
  await expect(backToSettings).toBeVisible();
  await backToSettings.click();

  const settingsDialog = page.getByRole('dialog', { name: /^Settings/ });
  const closeSettings = settingsDialog.getByRole('button', {
    name: 'Close dialog',
    exact: true,
  });
  await expect(closeSettings).toBeVisible();
  await closeSettings.click();
  await expect(settingsDialog).toBeHidden();

  const declineOptionalCookies = page.getByRole('button', {
    name: 'Decline Non-Essential',
    exact: true,
  });
  await declineOptionalCookies.click();
  await expect(declineOptionalCookies).toBeHidden();

  const chooserPromise = page.waitForEvent('filechooser');
  await page
    .getByText('Drop your file(s) here, or click to select', { exact: true })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles([
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
