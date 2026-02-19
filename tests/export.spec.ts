import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';
import { execFile } from 'child_process';
import { setupTest, uploadAndDisplay } from './helpers';

const execFileAsync = util.promisify(execFile);

async function getBookIdFromUrl(page: Page, expectedPrefix: 'pdf' | 'epub') {
  const url = new URL(page.url());
  const segments = url.pathname.split('/').filter(Boolean);
  expect(segments[0]).toBe(expectedPrefix);
  const bookId = segments[1];
  expect(bookId).toBeTruthy();
  return bookId;
}

async function openExportModal(page: Page) {
  const exportButton = page.getByRole('button', { name: 'Open audiobook export' });
  await expect(exportButton).toBeVisible({ timeout: 15_000 });
  await exportButton.click();
  await expect(page.getByRole('heading', { name: 'Export Audiobook' })).toBeVisible({ timeout: 15_000 });
}

async function setContainerFormatToMP3(page: Page) {
  const formatTrigger = page.getByRole('button', { name: /M4B|MP3/i });
  await expect(formatTrigger).toBeVisible({ timeout: 15_000 });
  await formatTrigger.click();
  await page.getByRole('option', { name: 'MP3' }).click();
}

async function startGeneration(page: Page) {
  const startButton = page.getByRole('button', { name: 'Start Generation' });
  await expect(startButton).toBeVisible({ timeout: 15_000 });
  await startButton.click();
}

async function waitForChaptersHeading(page: Page) {
  await expect(page.getByRole('heading', { name: 'Chapters' })).toBeVisible({ timeout: 60_000 });
}

type DownloadedAudiobook = {
  filePath: string;
  suggestedFilename: string;
  cleanup: () => Promise<void>;
};

async function downloadFullAudiobook(page: Page, timeoutMs = 60_000): Promise<DownloadedAudiobook> {
  const fullDownloadButton = page.getByRole('button', { name: /Full Download/i });
  await expect(fullDownloadButton).toBeVisible({ timeout: timeoutMs });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: timeoutMs }),
    fullDownloadButton.click(),
  ]);
  const failure = await download.failure();
  expect(failure).toBeNull();

  const suggestedFilename = download.suggestedFilename();
  let createdTempDir: string | null = null;
  let filePath = await download.path();

  // Some environments/browsers may not expose a stable download path; fall back to saving
  // into a temp directory outside the repo (and clean up after assertions).
  if (!filePath) {
    createdTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openreader-audiobook-'));
    const name = suggestedFilename || `download_${Date.now()}.mp3`;
    filePath = path.join(createdTempDir, name);
    await download.saveAs(filePath);
  }

  expect(fs.existsSync(filePath)).toBeTruthy();
  const stats = fs.statSync(filePath);
  expect(stats.size).toBeGreaterThan(0);
  return {
    filePath,
    suggestedFilename,
    cleanup: async () => {
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // ignore
      }
      if (createdTempDir) {
        await fs.promises.rm(createdTempDir, { recursive: true, force: true });
      }
    },
  };
}

async function getAudioDurationSeconds(filePath: string) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    filePath,
  ]);
  return parseFloat(stdout.trim());
}

async function expectChaptersBackendState(page: Page, bookId: string) {
  const res = await page.request.get(`/api/audiobook/status?bookId=${bookId}`);
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  return json;
}

async function withDownloadedFullAudiobook<T>(
  page: Page,
  fn: (args: { filePath: string; suggestedFilename: string }) => Promise<T>,
  timeoutMs = 60_000
): Promise<T> {
  const dl = await downloadFullAudiobook(page, timeoutMs);
  try {
    return await fn({ filePath: dl.filePath, suggestedFilename: dl.suggestedFilename });
  } finally {
    await dl.cleanup();
  }
}

/**
 * Poll the backend until the chapter count stops changing for `stableMs` milliseconds.
 * This helps avoid race conditions where in-flight TTS requests complete after cancellation.
 */
async function waitForStableChapterCount(
  page: Page,
  bookId: string,
  { stableMs = 2000, timeoutMs = 30000 } = {}
): Promise<{ count: number; json: ReturnType<typeof expectChaptersBackendState> extends Promise<infer T> ? T : never }> {
  const startTime = Date.now();
  let lastCount = -1;
  let lastStableTime = Date.now();
  let lastJson: Awaited<ReturnType<typeof expectChaptersBackendState>> | null = null;

  while (Date.now() - startTime < timeoutMs) {
    const json = await expectChaptersBackendState(page, bookId);
    const currentCount = json.chapters?.length ?? 0;
    lastJson = json;

    if (currentCount !== lastCount) {
      lastCount = currentCount;
      lastStableTime = Date.now();
    } else if (Date.now() - lastStableTime >= stableMs) {
      // Count has been stable for stableMs
      return { count: currentCount, json };
    }

    await page.waitForTimeout(200);
  }

  // Timeout reached, return whatever we have
  return { count: lastCount, json: lastJson! };
}

async function resetAudiobookById(page: Page, bookId: string) {
  const res = await page.request.delete(`/api/audiobook?bookId=${bookId}`);
  expect(res.ok() || res.status() === 404).toBeTruthy();
}

async function resetAudiobookIfPresent(page: Page) {
  const resetButtons = page.getByRole('button', { name: 'Reset' });
  const count = await resetButtons.count();

  if (count === 0) {
    return;
  }

  const resetButton = resetButtons.first();
  await resetButton.click();

  await expect(page.getByRole('heading', { name: 'Reset Audiobook' })).toBeVisible({ timeout: 15_000 });
  const confirmReset = page.getByRole('button', { name: 'Reset' }).last();
  await confirmReset.click();

  await expect(page.getByRole('button', { name: 'Start Generation' })).toBeVisible({ timeout: 60_000 });
}

test('exports full MP3 audiobook for PDF using mocked 10s TTS sample', async ({ page }, testInfo) => {
  // Ensure TTS is mocked and app is ready
  await setupTest(page, testInfo);

  // Upload and open the sample PDF in the viewer
  await uploadAndDisplay(page, 'sample.pdf');

  // Capture the generated document/book id from the /pdf/[id] URL
  const bookId = await getBookIdFromUrl(page, 'pdf');
  await resetAudiobookById(page, bookId);

  // Open the audiobook export modal from the header button
  await openExportModal(page);

  // While there are no chapters yet, we can still switch the container format.
  // Choose MP3 so we can validate MP3 duration end-to-end.
  await setContainerFormatToMP3(page);

  // Start generation; this will call the mocked /api/tts which returns a 10s sample.mp3 per page
  await startGeneration(page);

  // Wait for chapters list to appear and populate at least two items (Pages 1 and 2)
  await waitForChaptersHeading(page);
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await expect(chapterActionsButtons).toHaveCount(2, { timeout: 60_000 });

  // Trigger full download from the FRONTEND button and capture via Playwright's download API.
  // The button label can be "Full Download (MP3)" or "Full Download (M4B)" depending on
  // the server-side detected format, so match more loosely on the accessible name.
  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    // Use ffprobe (same toolchain as the server) to validate the combined audio duration.
    // The TTS route is mocked to return a 10s sample.mp3 for each page, so with at least
    // two chapters we should be close to ~20 seconds of audio.
    const durationSeconds = await getAudioDurationSeconds(filePath);
    // Duration must be within a reasonable window around 20 seconds to allow
    // for encoding variations and container overhead.
    expect(durationSeconds).toBeGreaterThan(18);
    expect(durationSeconds).toBeLessThan(22);
  });

  // Also check the chapter metadata API for consistency
  const json = await expectChaptersBackendState(page, bookId);
  expect(json.exists).toBe(true);
  expect(Array.isArray(json.chapters)).toBe(true);
  expect(json.chapters.length).toBeGreaterThanOrEqual(2);
  for (const ch of json.chapters) {
    expect(ch.duration).toBeGreaterThan(0);
  }

  await resetAudiobookIfPresent(page);
});

test('exports partial MP3 audiobook for EPUB using mocked 10s TTS sample', async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  await setupTest(page, testInfo);

  // Upload and open the sample EPUB in the viewer
  await uploadAndDisplay(page, 'sample.epub');

  // URL should now be /epub/[id]
  const bookId = await getBookIdFromUrl(page, 'epub');
  await resetAudiobookById(page, bookId);

  // Open the audiobook export modal from the header button
  await openExportModal(page);

  // Set container format to MP3
  await setContainerFormatToMP3(page);

  // Start generation
  await startGeneration(page);

  // Progress card should appear with a Cancel button while chapters are being generated
  const generationCard = page.locator('div', { hasText: 'Generating Audiobook' }).first();
  const cancelButton = generationCard.getByRole('button', { name: 'Cancel' });
  await expect(cancelButton).toBeVisible({ timeout: 60_000 });

  await expect(page.getByRole('heading', { name: 'Chapters' })).toBeVisible({ timeout: 60_000 });

  // Wait until at least 3 chapters are listed in the UI; record the exact count at the
  // moment we decide to cancel, and assert that no additional chapters are added afterward.
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await expect(chapterActionsButtons.nth(2)).toBeVisible({ timeout: 120_000 });
  const chapterCountBeforeCancel = await chapterActionsButtons.count();
  expect(chapterCountBeforeCancel).toBeGreaterThanOrEqual(3);

  // Now cancel the in-flight generation
  await cancelButton.click();

  // Cancellation is asynchronous: wait for generation to settle before asserting
  // that the inline progress card has disappeared.
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 30_000 });
  await expect(generationCard).toHaveCount(0, { timeout: 30_000 });

  // After cancellation, wait for the chapter count to stabilize. In-flight TTS
  // requests may still complete after we click cancel, so we poll until the
  // count stops changing for a brief period.
  const { count: chapterCountAfterCancel, json: jsonAfterCancel } = await waitForStableChapterCount(
    page,
    bookId,
    { stableMs: 2000, timeoutMs: 30000 }
  );
  expect(jsonAfterCancel.exists).toBe(true);
  expect(Array.isArray(jsonAfterCancel.chapters)).toBe(true);
  expect(chapterCountAfterCancel).toBeGreaterThanOrEqual(chapterCountBeforeCancel);

  // UI refresh can lag behind backend stabilization after cancellation; require at
  // least the pre-cancel chapter count instead of exact backend parity.
  await expect
    .poll(async () => chapterActionsButtons.count(), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(chapterCountBeforeCancel);

  // The Full Download button should still be available for the partially generated audiobook
  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    const durationSeconds = await getAudioDurationSeconds(filePath);
    expect(durationSeconds).toBeGreaterThan(25);
    expect(durationSeconds).toBeLessThan(300);
  });

  // Backend should still reflect the same number of chapters as when we first
  // observed the stabilized post-cancellation state.
  const json = await expectChaptersBackendState(page, bookId);
  expect(json.exists).toBe(true);
  expect(Array.isArray(json.chapters)).toBe(true);
  expect(json.chapters.length).toBe(chapterCountAfterCancel);

  await resetAudiobookIfPresent(page);
});

test('exports a single MP3 audiobook PDF page via chapters menu', async ({ page }, testInfo) => {
  await setupTest(page, testInfo);
  await uploadAndDisplay(page, 'sample.pdf');

  const bookId = await getBookIdFromUrl(page, 'pdf');
  await resetAudiobookById(page, bookId);

  await openExportModal(page);
  await setContainerFormatToMP3(page);
  await startGeneration(page);

  await waitForChaptersHeading(page);

  // Wait for at least one chapter row to appear (one "Chapter actions" button)
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await expect(chapterActionsButtons.first()).toBeVisible({ timeout: 90_000 });

  // Download via frontend button
  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    const durationSeconds = await getAudioDurationSeconds(filePath);
    // For EPUB we just assert a sane non-trivial duration; at least one 10s mocked chapter.
    expect(durationSeconds).toBeGreaterThan(9);
    expect(durationSeconds).toBeLessThan(300);
  });

  await resetAudiobookIfPresent(page);
});

test('resets all MP3 audiobook PDF pages', async ({ page }, testInfo) => {
  await setupTest(page, testInfo);
  await uploadAndDisplay(page, 'sample.pdf');

  const bookId = await getBookIdFromUrl(page, 'pdf');
  await resetAudiobookById(page, bookId);

  await openExportModal(page);
  await setContainerFormatToMP3(page);
  await startGeneration(page);

  await waitForChaptersHeading(page);

  // Wait for Reset button to become visible, indicating resumable/generated state
  const resetButton = page.getByRole('button', { name: 'Reset' });
  await expect(resetButton).toBeVisible({ timeout: 120_000 });

  await resetButton.click();

  // Confirm in the Reset Audiobook dialog
  await expect(page.getByRole('heading', { name: 'Reset Audiobook' })).toBeVisible({ timeout: 15000 });
  const confirmReset = page.getByRole('button', { name: 'Reset' }).last();
  await confirmReset.click();

  // After reset, generation should be startable again
  await expect(page.getByRole('button', { name: 'Start Generation' })).toBeVisible({ timeout: 60_000 });

  // Backend should report no existing chapters for this bookId
  const res = await page.request.get(`/api/audiobook/status?bookId=${bookId}`);
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  expect(json.exists).toBe(false);
  expect(Array.isArray(json.chapters)).toBe(true);
  expect(json.chapters.length).toBe(0);
});

test('regenerates a single MP3 audiobook PDF page and exports full audiobook', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await setupTest(page, testInfo);
  await uploadAndDisplay(page, 'sample.pdf');

  // Extract bookId from /pdf/[id] URL (for backend verification later)
  const bookId = await getBookIdFromUrl(page, 'pdf');
  await resetAudiobookById(page, bookId);

  // Open Export Audiobook modal
  await openExportModal(page);

  // Set container format to MP3
  await setContainerFormatToMP3(page);

  // Start generation
  await startGeneration(page);

  // Wait for chapters to appear
  await waitForChaptersHeading(page);

  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  // Ensure we have at least two chapters for this PDF
  await expect(chapterActionsButtons.nth(1)).toBeVisible({ timeout: 60_000 });
  const chapterCountBefore = await chapterActionsButtons.count();
  expect(chapterCountBefore).toBeGreaterThanOrEqual(2);

  // Open the actions menu for the first chapter and trigger Regenerate
  const firstChapterActions = chapterActionsButtons.first();
  await firstChapterActions.click();

  // In the headlessui Menu, each option is a menuitem. Use that role instead of button.
  const regenerateMenuItem = page.getByRole('menuitem', { name: /Regenerate/i });
  await expect(regenerateMenuItem).toBeVisible({ timeout: 15000 });
  await regenerateMenuItem.click();

  // During regeneration, the row may show a "Regenerating" label; wait for any such
  // indicator to disappear, signaling completion.
  const regeneratingLabel = page.getByText(/Regenerating/);
  await expect(regeneratingLabel).toHaveCount(0, { timeout: 120_000 });

  // After regeneration completes in the UI, verify backend chapter state is fully updated
  // before triggering a full download to avoid races with ffmpeg concat on Alpine.
  const backendStateAfterRegenerate = await expectChaptersBackendState(page, bookId);
  expect(backendStateAfterRegenerate.exists).toBe(true);
  expect(Array.isArray(backendStateAfterRegenerate.chapters)).toBe(true);
  expect(backendStateAfterRegenerate.chapters.length).toBe(chapterCountBefore);
  for (const ch of backendStateAfterRegenerate.chapters) {
    expect(ch.duration).toBeGreaterThan(0);
  }

  // Chapter count should remain exactly the same after regeneration (no duplicates)
  await expect(chapterActionsButtons).toHaveCount(chapterCountBefore, { timeout: 20_000 });

  // Full Download should still work and produce a valid combined audiobook
  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    const durationSeconds = await getAudioDurationSeconds(filePath);
    // With two mocked 10s chapters we expect roughly 20s; allow a small window.
    expect(durationSeconds).toBeGreaterThan(18);
    expect(durationSeconds).toBeLessThan(22);
  });

  // Backend should still report the same number of chapters and valid durations
  const json = await expectChaptersBackendState(page, bookId);
  expect(json.exists).toBe(true);
  expect(Array.isArray(json.chapters)).toBe(true);
  expect(json.chapters.length).toBe(chapterCountBefore);
  for (const ch of json.chapters) {
    expect(ch.duration).toBeGreaterThan(0);
  }

  await resetAudiobookIfPresent(page);
});

test('resumes audiobook when a chapter is missing and full download succeeds (PDF)', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await setupTest(page, testInfo);
  await uploadAndDisplay(page, 'sample.pdf');

  const bookId = await getBookIdFromUrl(page, 'pdf');
  await resetAudiobookById(page, bookId);

  await openExportModal(page);
  await setContainerFormatToMP3(page);
  await startGeneration(page);

  await waitForChaptersHeading(page);
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await expect(chapterActionsButtons).toHaveCount(2, { timeout: 60_000 });

  // Delete the first chapter via the backend API so the audiobook has a missing index (0).
  // This is more reliable than clicking through the chapter actions menu in headless runs.
  const deleteRes = await page.request.delete(`/api/audiobook/chapter?bookId=${bookId}&chapterIndex=0`);
  expect(deleteRes.ok()).toBeTruthy();

  // Wait for backend to reflect only one remaining chapter (index 1).
  await expect
    .poll(async () => {
      const json = await expectChaptersBackendState(page, bookId);
      return json.chapters?.length ?? 0;
    }, { timeout: 30_000 })
    .toBe(1);

  const jsonAfterDelete = await expectChaptersBackendState(page, bookId);
  expect(jsonAfterDelete.exists).toBe(true);
  expect(Array.isArray(jsonAfterDelete.chapters)).toBe(true);
  expect(jsonAfterDelete.chapters.length).toBe(1);
  expect(jsonAfterDelete.chapters[0]?.index).toBe(1);

  // Close and reopen the modal to ensure "resume" loads the missing placeholder from the backend.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { name: 'Export Audiobook' })).toHaveCount(0);
  await openExportModal(page);

  await waitForChaptersHeading(page);
  await expect(page.getByText(/Missing •/)).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 15_000 });

  // Resume should regenerate the missing chapter and allow a full download to succeed.
  await page.getByRole('button', { name: 'Resume' }).click();

  // Wait for backend to have both chapters again.
  await expect
    .poll(async () => {
      const json = await expectChaptersBackendState(page, bookId);
      return json.chapters?.length ?? 0;
    }, { timeout: 120_000 })
    .toBe(2);

  // UI should also stop showing a missing placeholder after resume completes.
  await expect(page.getByText(/Missing •/)).toHaveCount(0, { timeout: 120_000 });

  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    const durationSeconds = await getAudioDurationSeconds(filePath);
    expect(durationSeconds).toBeGreaterThan(18);
    expect(durationSeconds).toBeLessThan(22);
  });

  const jsonAfterResume = await expectChaptersBackendState(page, bookId);
  expect(jsonAfterResume.exists).toBe(true);
  expect(Array.isArray(jsonAfterResume.chapters)).toBe(true);
  expect(jsonAfterResume.chapters.length).toBe(2);
  expect(jsonAfterResume.chapters.map((c: { index: number }) => c.index).sort()).toEqual([0, 1]);
  for (const ch of jsonAfterResume.chapters) {
    expect(ch.duration).toBeGreaterThan(0);
  }

  await resetAudiobookIfPresent(page);
});
