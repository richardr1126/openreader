import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user changes voice and speed, then resumes playback', async ({ page }) => {
  test.setTimeout(180_000);
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, resolve('tests/files/multilingual-sample.txt'));
  const documentLink = page.getByRole('link', {
    name: 'multilingual-sample.txt',
    exact: true,
  });
  await expect(documentLink).toBeVisible({ timeout: 30_000 });
  await documentLink.click();

  await expect(
    page.getByRole('heading', { name: 'multilingual-sample.txt', exact: true }),
  ).toBeVisible({ timeout: 60_000 });

  const playButton = page.getByRole('button', { name: 'Play', exact: true });
  await expect(playButton).toBeEnabled({ timeout: 30_000 });
  await playButton.click();
  const pauseButton = page.getByRole('button', { name: 'Pause', exact: true });
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();
  await expect(playButton).toBeVisible();

  await page.getByRole('button', { name: 'Voice: F1', exact: true }).click();
  await page.getByRole('option', { name: 'F2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Voice: F2', exact: true })).toBeVisible();
  await expect(playButton).toBeEnabled({ timeout: 60_000 });

  await page.getByRole('button', { name: '1x', exact: true }).click();
  const nativeSpeed = page.getByRole('slider', { name: 'Native model speed', exact: true });
  const audioSpeed = page.getByRole('slider', { name: 'Audio player speed', exact: true });

  await nativeSpeed.focus();
  await nativeSpeed.press('ArrowRight');
  const changedSpeedButton = page.getByRole('button', { name: '1.1x', exact: true });
  await expect(changedSpeedButton).toBeEnabled({ timeout: 60_000 });

  await changedSpeedButton.click();
  await audioSpeed.focus();
  await audioSpeed.press('ArrowRight');
  await expect(page.getByRole('button', { name: '1.1x • 1.1x', exact: true })).toBeVisible();

  await playButton.click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'multilingual-sample.txt', exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Voice: F2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '1.1x • 1.1x', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
});
