import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('downloads account data and an already-completed audiobook export', async ({ page }) => {
  test.setTimeout(120_000);
  await enterAnonymousLibrary(page);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();

  const accountResolvePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/user/export'
  ));
  const accountDownloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByText('Export My Data', { exact: true }).click();
  const accountResolve = await accountResolvePromise;
  expect(accountResolve.ok(), await accountResolve.text()).toBe(true);
  const accountDownload = await accountDownloadPromise;
  expect(accountDownload.suggestedFilename()).toMatch(/^openreader-data-[A-Za-z0-9_-]+\.zip$/);

  await page.getByRole('link', { name: 'Close settings', exact: true }).click();
  await uploadLibraryFiles(page, resolve('tests/files/multilingual-sample.txt'));
  await page.getByRole('link', { name: 'multilingual-sample.txt', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'multilingual-sample.txt', exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 60_000,
  });

  const startIntents: boolean[] = [];
  await page.route('**/api/tts/export/resolve', async (route) => {
    const body = route.request().postDataJSON() as { start?: boolean };
    startIntents.push(body.start === true);
    await route.fulfill({
      json: {
        sessionId: 'completed-session',
        artifactId: 'completed-artifact',
        generation: {
          session: { status: 'succeeded' },
          operation: {
            opId: 'stale-generation-operation',
            status: 'failed',
            progress: { completedCount: 34, skippedCount: 1, plannedCount: 35 },
          },
          progress: { completedCount: 34, skippedCount: 1, plannedCount: 35 },
        },
        artifact: {
          artifact: {
            artifactId: 'completed-artifact',
            objectKey: 'exports/completed.mp3',
            contentType: 'audio/mpeg',
            byteLength: 10,
            dispositionFilename: 'completed.mp3',
            format: 'mp3',
            speed: 1,
            generatedSegments: 34,
            skippedSegments: 1,
            plannedSegments: 35,
          },
          operation: null,
        },
        downloadUrl: '/api/tts/export/download?artifactId=completed-artifact&documentId=test-document',
      },
    });
  });
  await page.route('**/api/tts/export/download?**', async (route) => {
    await route.fulfill({
      body: 'fake audio',
      contentType: 'audio/mpeg',
      headers: { 'Content-Disposition': 'attachment; filename="completed.mp3"' },
    });
  });

  await page.getByRole('button', { name: 'Open audiobook export', exact: true }).click();
  const exportSidebar = page.getByRole('dialog', { name: 'Export audiobook', exact: true });
  await expect(exportSidebar.getByText('Ready', { exact: true })).toBeVisible();
  await expect(exportSidebar.getByText(/1 segment was unable to be narrated/)).toBeVisible();
  const downloadButton = exportSidebar.getByRole('button', { name: 'Download', exact: true });
  await expect(downloadButton).toBeEnabled();
  expect(startIntents).toEqual([false]);

  const audiobookDownloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const audiobookDownload = await audiobookDownloadPromise;
  expect(audiobookDownload.suggestedFilename()).toMatch(/\.mp3$/);
});
