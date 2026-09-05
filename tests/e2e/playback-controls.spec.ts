import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

async function openDocument(
  page: Page,
  documentLink: Locator,
  documentName: string,
  readyTimeout = 60_000,
) {
  await documentLink.click();
  await expect(page.getByRole('heading', { name: documentName, exact: true })).toBeVisible({
    timeout: readyTimeout,
  });
}

async function startAndCancelPlayback(page: Page) {
  const playButton = page.getByRole('button', { name: 'Play', exact: true });
  await expect(playButton).toBeEnabled({ timeout: 30_000 });
  await playButton.focus();
  await page.keyboard.press('Enter');

  const cancelButton = page.getByRole('button', {
    name: 'Cancel playback loading',
    exact: true,
  });
  const pauseButton = page.getByRole('button', { name: 'Pause', exact: true });
  const stopButton = cancelButton.or(pauseButton);
  await expect(stopButton).toBeVisible({ timeout: 30_000 });
  await expect(stopButton).toBeFocused();
  await page.keyboard.press('Space');
  await expect(playButton).toBeVisible();
  await expect(playButton).toBeFocused();
}

type PlaybackSessionResponse = {
  seekLayoutUrl: string;
};

type PlaybackSeekLayout = {
  durationMs: number;
  segments: Array<{ generated?: boolean; audioState?: string }>;
};

async function readPlaybackPosition(page: Page) {
  return Number(await page.getByRole('slider', {
    name: 'Playback position',
    exact: true,
  }).inputValue());
}

async function readGeneratedSegmentCount(page: Page, seekLayoutUrl: string) {
  return await page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Seek layout request failed: ${response.status}`);
    const layout = await response.json() as PlaybackSeekLayout;
    return layout.segments.filter((segment) => (
      segment.generated === true || segment.audioState === 'ready'
    )).length;
  }, seekLayoutUrl);
}

async function readEpubWordHighlight(page: Page) {
  return await page.frameLocator('iframe').locator('body').evaluate((body) => {
    type HighlightRegistry = {
      get: (name: string) => Iterable<Range> | undefined;
    };
    const view = body.ownerDocument.defaultView as (Window & {
      CSS: typeof CSS & { highlights?: HighlightRegistry };
    }) | null;
    const highlight = view?.CSS?.highlights?.get('openreader-epub-word');
    return highlight
      ? Array.from(highlight).map((range) => range.toString()).join(' ').trim()
      : '';
  });
}

async function verifyEpubPlayback(page: Page) {
  const playButton = page.getByRole('button', { name: 'Play', exact: true });
  const position = page.getByRole('slider', { name: 'Playback position', exact: true });
  const initialViewportHeading = page.frameLocator('iframe').getByRole('heading').first();
  await expect(initialViewportHeading).toBeInViewport();
  // The EPUB rendition and its asynchronous duration projection become ready
  // independently. Wait for the same required value instead of sampling once.
  await expect.poll(async () => Number(await position.getAttribute('max')))
    .toBeGreaterThan(0);
  const documentDuration = Number(await position.getAttribute('max'));

  const sessionResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/tts/stream/sessions'
  ));

  await playButton.click();
  const loadingButton = page.getByRole('button', {
    name: 'Cancel playback loading',
    exact: true,
  });
  await expect(loadingButton).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/^(Preparing|Loading) audio…$/)).toBeVisible();

  const sessionResponse = await sessionResponsePromise;
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json() as PlaybackSessionResponse;
  expect(session.seekLayoutUrl).toBeTruthy();

  const pauseButton = page.getByRole('button', { name: 'Pause', exact: true });
  await expect(pauseButton).toBeVisible({ timeout: 60_000 });
  const startedAt = await readPlaybackPosition(page);
  await expect.poll(() => readPlaybackPosition(page), { timeout: 15_000 })
    .toBeGreaterThan(startedAt + 1);

  await expect.poll(() => readEpubWordHighlight(page), { timeout: 15_000 })
    .not.toBe('');
  const firstHighlightedWord = await readEpubWordHighlight(page);
  await expect.poll(() => readEpubWordHighlight(page), { timeout: 15_000 })
    .not.toBe(firstHighlightedWord);

  await pauseButton.click();
  await expect(playButton).toBeVisible();
  const pausedAt = await readPlaybackPosition(page);
  await page.waitForTimeout(1_500);
  expect(await readPlaybackPosition(page)).toBeCloseTo(pausedAt, 0);

  // A segment that was already synthesizing may finish after pause. Once that
  // boundary settles, no further background generation should continue.
  await page.waitForTimeout(4_000);
  const settledGeneratedCount = await readGeneratedSegmentCount(page, session.seekLayoutUrl);
  await page.waitForTimeout(4_000);
  expect(await readGeneratedSegmentCount(page, session.seekLayoutUrl))
    .toBe(settledGeneratedCount);

  await page.getByRole('button', { name: 'Next section', exact: true }).click();
  await expect(initialViewportHeading).not.toBeInViewport({ timeout: 15_000 });
  await expect.poll(async () => Number(await position.getAttribute('max')))
    .toBeGreaterThan(documentDuration * 0.9);
  expect(await readGeneratedSegmentCount(page, session.seekLayoutUrl))
    .toBeGreaterThanOrEqual(settledGeneratedCount);

  // Resume from a different EPUB section in the same canonical session. This
  // catches stale async rendition navigation that can leave audio advancing in
  // one spine while the rendered text and word highlight remain in another.
  await playButton.click();
  await expect(pauseButton).toBeVisible({ timeout: 60_000 });
  const resumedAt = await readPlaybackPosition(page);
  await expect.poll(() => readPlaybackPosition(page), { timeout: 15_000 })
    .toBeGreaterThan(resumedAt + 1);
  await expect.poll(() => readEpubWordHighlight(page), { timeout: 15_000 })
    .not.toBe('');
  await pauseButton.click();
  await expect(playButton).toBeVisible();

  await page.getByRole('button', { name: 'Previous section', exact: true }).click();
}

async function returnToLibrary(page: Page) {
  await page.getByRole('link', { name: 'Back to documents', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test('anonymous user controls playback across every accepted document journey', async ({ page }) => {
  test.setTimeout(180_000);
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, [
    resolve('tests/files/multilingual-sample.txt'),
    resolve('tests/files/sample.md'),
    resolve('tests/files/sample.epub'),
    resolve('tests/files/sample.pdf'),
  ]);

  for (const documentName of [
    'multilingual-sample.txt',
    'sample.md',
    'sample.epub',
  ]) {
    await expect(page.getByRole('link', { name: documentName, exact: true })).toBeVisible({
      timeout: 30_000,
    });
  }

  await page
    .getByRole('complementary')
    .getByText('Upload documents', { exact: true })
    .click();
  const uploadDialog = page.getByRole('dialog', { name: 'Add Documents', exact: true });
  await expect(uploadDialog.getByRole('heading', { name: 'Add Documents', exact: true })).toBeVisible();
  const docxChooserPromise = page.waitForEvent('filechooser');
  await uploadDialog
    .getByText('Drop your file(s) here, or click to select', { exact: true })
    .click();
  const docxChooser = await docxChooserPromise;
  await docxChooser.setFiles(resolve('tests/files/sample.docx'));

  const pdfLinks = page.getByRole('link', { name: 'sample.pdf', exact: true });
  await expect(pdfLinks).toHaveCount(2, { timeout: 60_000 });

  await openDocument(
    page,
    page.getByRole('link', { name: 'multilingual-sample.txt', exact: true }),
    'multilingual-sample.txt',
  );
  await startAndCancelPlayback(page);

  const playButton = page.getByRole('button', { name: 'Play', exact: true });
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

  await startAndCancelPlayback(page);

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'multilingual-sample.txt', exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Voice: F2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '1.1x • 1.1x', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await returnToLibrary(page);

  await openDocument(
    page,
    page.getByRole('link', { name: 'sample.md', exact: true }),
    'sample.md',
  );
  await startAndCancelPlayback(page);
  await returnToLibrary(page);

  await openDocument(
    page,
    page.getByRole('link', { name: 'sample.epub', exact: true }),
    'sample.epub',
  );
  const bookTitle = page.frameLocator('iframe').getByRole('heading', {
    name: 'The Wonderful Wizard of Oz',
    exact: true,
  });
  await expect(bookTitle).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();

  await verifyEpubPlayback(page);

  await page.setViewportSize({ width: 600, height: 800 });

  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(bookTitle).toBeVisible();

  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const mobileMenu = page.getByRole('menu');
  await expect(mobileMenu.getByText('Zoom / Padding', { exact: true })).toBeVisible();
  await expect(mobileMenu.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });

  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(bookTitle).toBeVisible();
  await returnToLibrary(page);

  await openDocument(page, pdfLinks.nth(0), 'sample.pdf');
  await startAndCancelPlayback(page);
  await returnToLibrary(page);

  await openDocument(page, pdfLinks.nth(1), 'sample.pdf', 60_000);
  await startAndCancelPlayback(page);
  await returnToLibrary(page);
});
