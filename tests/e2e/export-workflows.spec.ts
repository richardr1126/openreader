import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('downloads account data and an already-completed audiobook export', async ({ page }) => {
  test.setTimeout(120_000);
  await enterAnonymousLibrary(page);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Storage', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Library storage', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reclaim orphaned audio', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete all audio', exact: true })).toBeEnabled();
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

  let releaseMeasurement!: () => void;
  const measurementGate = new Promise<void>((resolve) => { releaseMeasurement = resolve; });
  let measurementAttempts = 0;
  await page.route('**/api/tts/storage/document', async (route) => {
    measurementAttempts += 1;
    if (measurementAttempts === 1) {
      await measurementGate;
      await route.fulfill({ status: 503, json: { error: 'The compute worker does not support storage measurement. Redeploy the worker to match the web version.' } });
    } else {
      await route.fulfill({ json: { currentAudioBytes: 1024, unusedAudioBytes: 0, documentDataBytes: 512, truncated: false } });
    }
  });
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const documentSettings = page.getByRole('dialog', { name: 'Document settings', exact: true });
  await expect(documentSettings.getByText('Measuring document storage…', { exact: true })).toBeVisible();
  releaseMeasurement();
  await expect(documentSettings.getByText(/Redeploy the worker to match the web version/)).toBeVisible();
  await documentSettings.getByRole('button', { name: 'Retry measurement', exact: true }).click();
  await expect(documentSettings.getByText('1.0 KB', { exact: true })).toBeVisible();
  await expect(documentSettings.getByRole('button', { name: 'Reclaim unused audio', exact: true })).toBeDisabled();
  await documentSettings.getByRole('button', { name: 'Close', exact: true }).click();

  const resolveActions: string[] = [];
  const artifactSubscriptions: string[] = [];
  let bookArtifactReady = false;
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  let releaseChapters!: () => void;
  const chapterGate = new Promise<void>((resolve) => { releaseChapters = resolve; });
  let filePhase: 'transcoding' | 'uploading' | 'ready' = 'transcoding';
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  let m4bGenerationState: 'idle' | 'queued' | 'stopped' = 'idle';
  const chapters = [
    { index: 0, title: 'Chapter 1', spineHref: null, page: null, plannedSegments: 20, completedSegments: 20, skippedSegments: 0, generatingSegments: 0, durationMs: 65_000 },
    { index: 1, title: 'Chapter 2', spineHref: null, page: null, plannedSegments: 15, completedSegments: 14, skippedSegments: 1, generatingSegments: 0, durationMs: 48_000 },
  ];
  await page.route('**/api/tts/export/resolve', async (route) => {
    const body = route.request().postDataJSON() as { action: string; format: string; chapterIndex?: number; includeProgress?: boolean };
    resolveActions.push(body.chapterIndex === undefined ? body.action : `${body.action}:${body.chapterIndex}`);
    if (resolveActions.length === 1) await lookupGate;
    if (body.includeProgress === true) await chapterGate;
    if (body.format === 'm4b') {
      if (body.action === 'start') { await startGate; m4bGenerationState = 'queued'; }
      if (body.action === 'stop') { await stopGate; m4bGenerationState = 'stopped'; }
      await route.fulfill({ json: {
        sessionId: 'm4b-session', artifactId: 'm4b-artifact', chapterIndex: null,
        generation: { state: m4bGenerationState, operationId: m4bGenerationState === 'queued' ? 'm4b-generation' : null, issue: null },
        progress: null, artifact: { state: 'none', operationId: null, issue: null }, download: null,
      } });
      return;
    }
    const chapterDownload = body.chapterIndex !== undefined;
    const artifactReady = chapterDownload || bookArtifactReady;
    await route.fulfill({
      json: {
        sessionId: 'completed-session',
        artifactId: chapterDownload ? 'chapter-artifact' : 'completed-artifact',
        chapterIndex: body.chapterIndex ?? null,
        generation: { state: 'complete', operationId: 'generation-operation', issue: null },
        progress: body.includeProgress === false ? null : {
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
    if (operationId === 'm4b-generation') {
      await route.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify({
        snapshot: { opId: operationId, status: 'running', progress: { phase: 'checking_cache',
          completedCount: 0, skippedCount: 0, plannedCount: 35, completedThroughOrdinal: -1 } },
      })}\n\n` });
      return;
    }
    artifactSubscriptions.push(operationId);
    bookArtifactReady = filePhase === 'ready';
    await route.fulfill({
      body: `event: snapshot\ndata: ${JSON.stringify({
        snapshot: {
          opId: operationId,
          status: bookArtifactReady ? 'succeeded' : 'running',
          progress: { phase: filePhase === 'ready' ? 'uploading' : filePhase,
            completedSegments: 35, skippedSegments: 1, plannedSegments: 35 },
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
  await expect(exportSidebar.getByText('Checking for a saved audiobook…', { exact: true })).toBeVisible();
  await expect(exportSidebar.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
  releaseLookup();
  await expect(exportSidebar.getByText('Encoding MP3', { exact: true })).toBeVisible();
  await expect(exportSidebar.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await expect(exportSidebar.getByText('Loading chapter progress…', { exact: true })).toBeVisible();
  releaseChapters();
  await expect(exportSidebar.getByRole('list', { name: 'Audiobook chapters', exact: true })).toBeVisible();
  filePhase = 'uploading';
  await expect(exportSidebar.getByText('Uploading file', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(exportSidebar.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  filePhase = 'ready';
  await expect(exportSidebar.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(exportSidebar.getByText(/1 segment could not be narrated/)).toBeVisible();
  await expect(exportSidebar.getByRole('button', { name: 'Retry 1 skipped segment', exact: true })).toBeVisible();
  const chapterList = exportSidebar.getByRole('list', { name: 'Audiobook chapters', exact: true });
  await expect(chapterList.getByRole('listitem')).toHaveCount(2);
  await expect(chapterList.getByText('1:05', { exact: true })).toBeVisible();
  const downloadButton = exportSidebar.getByRole('button', { name: 'Download', exact: true });
  await expect(downloadButton).toBeEnabled();
  expect([...new Set(artifactSubscriptions)]).toEqual(['book-artifact-operation']);

  const chapterDownloadPromise = page.waitForEvent('download');
  await chapterList.getByRole('button', { name: 'Download Chapter 1', exact: true }).click();
  expect((await chapterDownloadPromise).suggestedFilename()).toBe('completed-chapter-001.mp3');

  const audiobookDownloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const audiobookDownload = await audiobookDownloadPromise;
  expect(audiobookDownload.suggestedFilename()).toMatch(/\.mp3$/);
  expect(resolveActions[0]).toBe('resolve');
  expect(resolveActions).toContain('start:0');

  await exportSidebar.getByRole('radio', { name: 'M4B', exact: true }).click();
  await exportSidebar.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(exportSidebar.getByRole('button', { name: 'Starting…', exact: true })).toBeDisabled();
  releaseStart();
  await exportSidebar.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(exportSidebar.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
  releaseStop();
  await expect(exportSidebar.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();

  // The export shows the applied voice read-only; Change hands off to the
  // voice panel, the single owner of voice and model-speed edits.
  await exportSidebar.getByRole('button', { name: 'Change voice', exact: true }).click();
  const voicePanel = page.getByRole('dialog', { name: 'Voice', exact: true });
  await expect(voicePanel.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible();
  await expect(exportSidebar).toBeHidden();
  await expect(voicePanel.getByRole('searchbox', { name: 'Search voices' })).toBeVisible();
  await voicePanel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(voicePanel).toBeHidden();
});
