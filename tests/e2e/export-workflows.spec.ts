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

  const resolveActions: string[] = [];
  const artifactSubscriptions: string[] = [];
  let bookArtifactReady = false;
  const chapters = [
    { index: 0, title: 'Chapter 1', spineHref: null, page: null, plannedSegments: 20, completedSegments: 20, skippedSegments: 0, generatingSegments: 0, durationMs: 65_000 },
    { index: 1, title: 'Chapter 2', spineHref: null, page: null, plannedSegments: 15, completedSegments: 14, skippedSegments: 1, generatingSegments: 0, durationMs: 48_000 },
  ];
  await page.route('**/api/tts/export/resolve', async (route) => {
    const body = route.request().postDataJSON() as { action: string; chapterIndex?: number };
    resolveActions.push(body.chapterIndex === undefined ? body.action : `${body.action}:${body.chapterIndex}`);
    const chapterDownload = body.chapterIndex !== undefined;
    const artifactReady = chapterDownload || bookArtifactReady;
    await route.fulfill({
      json: {
        sessionId: 'completed-session',
        artifactId: chapterDownload ? 'chapter-artifact' : 'completed-artifact',
        chapterIndex: body.chapterIndex ?? null,
        generation: { state: 'complete', operationId: 'generation-operation', issue: null },
        progress: {
          plannedSegments: 35,
          completedSegments: 34,
          skippedSegments: 1,
          lastSkipIssue: { code: 'UPSTREAM_TIMEOUT', message: 'timed out' },
          chapters,
        },
        artifact: {
          state: artifactReady ? 'ready' : 'building',
          operationId: artifactReady ? null : 'book-artifact-operation',
          issue: null,
        },
        download: artifactReady
          ? {
            url: `/api/tts/export/download?artifactId=${chapterDownload ? 'chapter-artifact' : 'completed-artifact'}&documentId=test-document`,
            filename: chapterDownload ? 'completed-chapter-001.mp3' : 'completed.mp3',
          }
          : null,
      },
    });
  });
  await page.route('**/api/tts/export/events?**', async (route) => {
    const operationId = new URL(route.request().url()).searchParams.get('opId') ?? '';
    artifactSubscriptions.push(operationId);
    bookArtifactReady = true;
    await route.fulfill({
      body: `event: snapshot\ndata: ${JSON.stringify({
        snapshot: {
          opId: operationId,
          status: 'succeeded',
          progress: { completedSegments: 35, skippedSegments: 1, plannedSegments: 35 },
        },
      })}\n\n`,
      contentType: 'text/event-stream',
    });
  });
  await page.route('**/api/tts/export/download?**', async (route) => {
    const chapter = new URL(route.request().url()).searchParams.get('artifactId') === 'chapter-artifact';
    await route.fulfill({
      body: 'fake audio',
      contentType: 'audio/mpeg',
      headers: {
        'Content-Disposition': `attachment; filename="${chapter ? 'completed-chapter-001.mp3' : 'completed.mp3'}"`,
      },
    });
  });

  await page.getByRole('button', { name: 'Open audiobook export', exact: true }).click();
  const exportSidebar = page.getByRole('dialog', { name: 'Export audiobook', exact: true });
  await expect(exportSidebar.getByText('Ready', { exact: true })).toBeVisible();
  await expect(exportSidebar.getByText(/1 segment could not be narrated/)).toBeVisible();
  await expect(exportSidebar.getByRole('button', { name: 'Retry 1 skipped segment', exact: true })).toBeVisible();
  const chapterList = exportSidebar.getByRole('list', { name: 'Audiobook chapters', exact: true });
  await expect(chapterList.getByRole('listitem')).toHaveCount(2);
  await expect(chapterList.getByText('1:05', { exact: true })).toBeVisible();
  const downloadButton = exportSidebar.getByRole('button', { name: 'Download', exact: true });
  await expect(downloadButton).toBeEnabled();
  expect(artifactSubscriptions).toEqual(['book-artifact-operation']);

  const chapterDownloadPromise = page.waitForEvent('download');
  await chapterList.getByRole('button', { name: 'Download Chapter 1', exact: true }).click();
  expect((await chapterDownloadPromise).suggestedFilename()).toBe('completed-chapter-001.mp3');

  const audiobookDownloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const audiobookDownload = await audiobookDownloadPromise;
  expect(audiobookDownload.suggestedFilename()).toMatch(/\.mp3$/);
  expect(resolveActions).toEqual(['resolve', 'resolve', 'start:0']);
});
