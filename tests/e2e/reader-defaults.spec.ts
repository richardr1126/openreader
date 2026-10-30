import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function save(page: Page, regenerate = false) {
  await page.getByRole('region', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
  if (regenerate) await page.getByRole('button', { name: 'Change and regenerate', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unsaved changes', exact: true })).toBeHidden();
}

test('reader defaults inherit independently and speech saves preserve book display choices', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await enterAnonymousLibrary(page);
  await page.goto('/app/settings?section=customize');
  await page.getByRole('switch', { name: 'Show the pages', exact: true }).click();
  await save(page);
  await page.getByRole('radio', { name: 'EPUB', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Show the book', exact: true })).toBeChecked();

  await page.getByRole('switch', { name: 'Highlight segment', exact: true }).click();
  await save(page);
  await page.getByRole('button', { name: 'Model & Voice', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await choose(page, 'Max segment length', '600 characters');
  await page.getByRole('button', { name: 'PDF block kinds', exact: true }).click();
  await page.getByRole('switch', { name: 'Header', exact: true }).click();
  await save(page);

  await page.getByRole('link', { name: 'Close settings', exact: true }).click();
  await uploadLibraryFiles(page, resolve('tests/files/sample.pdf'));
  await page.getByRole('link', { name: 'sample.pdf', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Document text', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const pages = page.getByRole('switch', { name: 'Show the pages', exact: true });
  const segment = page.getByRole('switch', { name: 'Highlight segment', exact: true });
  await expect(pages).not.toBeChecked();
  await expect(segment).not.toBeChecked();
  await pages.click();
  await choose(page, 'Page mode', 'Two pages');
  await segment.click();
  await save(page);
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Max segment length', exact: true })).toHaveText('600 characters');
  await choose(page, 'Max segment length', '300 characters');
  await save(page, true);
  await expect(page.getByRole('switch', { name: 'Show block overlay', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Voice:/ }).first().click();
  const voicePanel = page.getByRole('dialog', { name: 'Voice', exact: true });
  await voicePanel.getByRole('button', { name: 'PDF block kinds', exact: true }).click();
  const header = voicePanel.getByRole('switch', { name: 'Header', exact: true });
  await expect(header).not.toBeChecked();
  await header.click();
  await page.getByRole('button', { name: 'Change and regenerate', exact: true }).click();
  await expect(header).toBeChecked();

  await page.reload();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(pages).toBeChecked();
  await expect(segment).toBeChecked();
  await expect(page.getByRole('button', { name: 'Page mode', exact: true })).toHaveText('Two pages');
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Max segment length', exact: true })).toHaveText('300 characters');
  await page.getByRole('button', { name: 'Use app default for max segment length', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Max segment length', exact: true })).toHaveText('600 characters');
  await save(page, true);
  await expect(page.getByRole('button', { name: 'Max segment length', exact: true })).toHaveText('600 characters');
  await page.getByRole('button', { name: 'Use app default for show the pages', exact: true }).click();
  await page.getByRole('button', { name: 'Use app default for highlight segment', exact: true }).click();
  await expect(pages).not.toBeChecked();
  await expect(segment).not.toBeChecked();
  await save(page);
  await expect(pages).not.toBeChecked();
  await expect(segment).not.toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Voice:/ }).first().click();
  await voicePanel.getByRole('button', { name: 'PDF block kinds', exact: true }).click();
  await expect(header).toBeChecked();
  await voicePanel.getByRole('button', { name: 'Use app default for PDF block kinds', exact: true }).click();
  await page.getByRole('button', { name: 'Change and regenerate', exact: true }).click();
  await expect(header).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Document text', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('reader-defaults-fixed.png') });
});
