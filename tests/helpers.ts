import { Page, expect, type TestInfo, type Locator } from '@playwright/test';
import { createHash } from 'crypto';

const DIR = './tests/files/';

// Small util to safely use filenames inside regex patterns
function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitForPdfViewerReady(page: Page, timeout = 60000) {
  await expect(page).toHaveURL(/\/pdf\/[A-Za-z0-9._%-]+$/, { timeout: Math.min(timeout, 20000) });
  const loader = page.getByTestId('pdf-status-loader').first();
  const parseFailedBanner = page.getByText('PDF parsing failed. Retry to continue.').first();
  await expect
    .poll(async () => {
      const parseFailed = await parseFailedBanner.isVisible().catch(() => false);
      if (parseFailed) return 'failed';

      const documentVisible = await page.locator('.react-pdf__Document').first().isVisible().catch(() => false);
      const pageVisible = await page.locator('.react-pdf__Page').first().isVisible().catch(() => false);
      const canvasVisible = await page.locator('.react-pdf__Page canvas').first().isVisible().catch(() => false);

      const hasRenderedPdf = documentVisible || pageVisible || canvasVisible;
      const loaderVisible = await loader.isVisible().catch(() => false);
      if (hasRenderedPdf && !loaderVisible) return 'ready';
      return 'loading';
    }, { timeout })
    .toBe('ready');
}

/**
 * Upload a sample document fixture
 */
export async function uploadFile(page: Page, filePath: string) {
  const input = page.locator('input[type=file]').first();
  await expect(input).toBeVisible({ timeout: 10000 });
  await expect(input).toBeEnabled({ timeout: 10000 });

  await input.setInputFiles(`${DIR}${filePath}`);

  // Wait for the uploader to finish processing. The input is disabled while
  // uploading via react-dropzone's `disabled` prop.
  // Tolerate extremely fast operations where the disabled state may be missed.
  try {
    await expect(input).toBeDisabled({ timeout: 2000 });
  } catch {
    // ignore
  }
  await expect(input).toBeEnabled({ timeout: 15000 });
}

/**
 * Upload and display a document
 */
export async function uploadAndDisplay(page: Page, fileName: string) {
  await uploadFile(page, fileName);

  const lower = fileName.toLowerCase();

  if (lower.endsWith('.docx')) {
    const convertedName = `${fileName.replace(/\.[^.]+$/, '')}.pdf`;
    const targetLink = page.getByRole('link', { name: new RegExp(escapeRegExp(convertedName), 'i') }).first();
    await expect(targetLink).toBeVisible({ timeout: 15000 });
    await dismissOnboardingModals(page);
    await targetLink.click();
    await waitForPdfViewerReady(page, 60000);
    return;
  }

  const targetLink = page.getByRole('link', { name: new RegExp(escapeRegExp(fileName), 'i') }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await dismissOnboardingModals(page);
    try {
      await targetLink.click({ timeout: 10000 });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(200);
    }
  }

  if (lower.endsWith('.pdf')) {
    await waitForPdfViewerReady(page, 60000);
  } else if (lower.endsWith('.epub')) {
    await page.waitForSelector('.epub-container', { timeout: 10000 });
  } else if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    await page.waitForSelector('.html-container', { timeout: 10000 });
  }
}

async function dismissOnboardingModals(page: Page): Promise<void> {
  const privacyDialog = page.getByTestId('privacy-modal');
  const claimDialog = page.getByTestId('claim-modal');
  const migrationDialog = page.getByTestId('migration-modal');
  const settingsDialog = page.getByTestId('settings-modal');

  const maxSteps = 12;
  const settleChecks = 3;
  let settledWithoutDialog = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    if (await privacyDialog.isVisible().catch(() => false)) {
      const privacyAgree = page.getByTestId('privacy-agree-checkbox');
      if (await privacyAgree.isVisible().catch(() => false)) {
        if (!(await privacyAgree.isChecked())) {
          await privacyAgree.check();
        }
      }
      const continueBtn = page.getByTestId('privacy-continue-button');
      await expect(continueBtn).toBeEnabled({ timeout: 10000 });
      await continueBtn.click();
      await privacyDialog.waitFor({ state: 'hidden', timeout: 15000 });
      await page.waitForTimeout(100);
      settledWithoutDialog = 0;
      continue;
    }

    if (await claimDialog.isVisible().catch(() => false)) {
      const dismissBtn = page.getByTestId('claim-dismiss-button');
      await expect(dismissBtn).toBeEnabled({ timeout: 10000 });
      await dismissBtn.click();
      await claimDialog.waitFor({ state: 'hidden', timeout: 15000 });
      await page.waitForTimeout(100);
      settledWithoutDialog = 0;
      continue;
    }

    if (await settingsDialog.isVisible().catch(() => false)) {
      const backToSettingsBtn = settingsDialog.getByRole('button', { name: /back to settings/i });
      if (await backToSettingsBtn.isVisible().catch(() => false)) {
        await expect(backToSettingsBtn).toBeEnabled({ timeout: 10000 });
        await backToSettingsBtn.click();
        await page.waitForTimeout(100);
      }

      // For test setup teardown, we only need to dismiss overlays.
      // Avoid saving because Save can race with state changes and detach.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.keyboard.press('Escape');
        const hidden = await settingsDialog.isHidden().catch(() => false);
        if (hidden) {
          break;
        }
        await page.waitForTimeout(100);
      }
      await settingsDialog.waitFor({ state: 'hidden', timeout: 15000 });
      await page.waitForTimeout(100);
      settledWithoutDialog = 0;
      continue;
    }

    if (await migrationDialog.isVisible().catch(() => false)) {
      const skipBtn = page.getByTestId('migration-skip-button');
      await expect(skipBtn).toBeEnabled({ timeout: 10000 });
      await skipBtn.click();
      await migrationDialog.waitFor({ state: 'hidden', timeout: 15000 });
      await page.waitForTimeout(100);
      settledWithoutDialog = 0;
      continue;
    }

    settledWithoutDialog += 1;
    if (settledWithoutDialog >= settleChecks) {
      return;
    }
    await page.waitForTimeout(150);
  }
}

/**
 * Wait for the play button to be clickable and click it
 */
export async function waitAndClickPlay(page: Page) {
  const playButton = page.getByRole('button', { name: 'Play' });
  await expect(playButton).toBeVisible();
  await expect(playButton).toBeEnabled({ timeout: 15000 });
  // Play the TTS by clicking the button
  await playButton.click();
  // Use resilient processing transition helper (tolerates fast completion)
  await expectProcessingTransition(page);
}

/**
 * Setup function for TTS playback tests
 */
export async function playTTSAndWaitForASecond(page: Page, fileName: string) {
  // Upload and display the document
  await uploadAndDisplay(page, fileName);
  // Wait for play button selector without disabled attribute
  await waitAndClickPlay(page);
  // play for 1s
  await page.waitForTimeout(1000);
}
/**
 * Pause TTS playback and verify paused state
 */
export async function pauseTTSAndVerify(page: Page) {
  const ttsbar = page.locator('[data-app-ttsbar]');
  const pauseButton = ttsbar.getByRole('button', { name: 'Pause' }).first();
  await expect(pauseButton).toBeVisible({ timeout: 15000 });
  await expect(pauseButton).toBeEnabled({ timeout: 15000 });

  // Retry pause because Firefox can race with transient processing transitions.
  for (let attempt = 0; attempt < 3; attempt++) {
    await pauseButton.click();
    try {
      await expect(ttsbar.getByRole('button', { name: 'Play' }).first()).toBeVisible({ timeout: 5000 });
      await expectMediaState(page, 'paused');
      return;
    } catch {
      if (attempt === 2) throw new Error('Failed to pause TTS playback after retries');
      await page.waitForTimeout(250);
    }
  }
}

/**
 * Common test setup function
 */
export async function setupTest(page: Page, testInfo?: TestInfo) {
  const namespace = testInfo
    ? `${testInfo.project.name}-w${testInfo.workerIndex}-r${testInfo.retry}-${createHash('sha1')
      .update(`${testInfo.file}|${testInfo.title}|${testInfo.repeatEachIndex}`)
      .digest('hex')
      .slice(0, 12)}`
    : null;
  if (namespace) {
    // Isolate server-side storage per test run (scoped by project/worker/retry/test)
    // to avoid cross-test flake from in-flight server-side writes.
    await page.context().setExtraHTTPHeaders({ 'x-openreader-test-namespace': namespace });
  }

  // Pre-seed consent to prevent the cookie banner from blocking interactions.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('cookie-consent', 'accepted');
    } catch {
      // ignore storage errors in restricted contexts
    }
  });

  // If we explicitly choose to bootstrap anonymous sessions for a test run,
  // do it before navigation so protected startup routes do not intermittently 401.
  // await ensureAnonymousSession(page);

  // Navigate to the protected app home before each test
  await page.goto('/app');
  await page.waitForLoadState('networkidle');

  // AuthLoader may show a full-screen overlay while session is loading.
  // Wait for it to be gone before interacting with underlying UI.
  await page
    .waitForSelector('.fixed.inset-0.bg-base.z-50', { state: 'detached', timeout: 15_000 })
    .catch(() => { });

  // Fallback: if the banner still appears, dismiss it before continuing.
  const cookieAcceptBtn = page.getByRole('button', { name: 'Accept All' });
  if (await cookieAcceptBtn.isVisible().catch(() => false)) {
    await cookieAcceptBtn.click();
  }

  // Close first-run dialogs (when present). These do not always appear.
  await dismissOnboardingModals(page);
}

/**
 * More reliable than Playwright's `locator.dragTo` when a drop immediately opens a modal
 * (which can intercept pointer events mid-gesture and cause flakiness).
 *
 * This uses DOM drag events directly; our app's doc list DnD logic only needs the events,
 * not a real OS-level drag interaction.
 */
export async function dispatchHtml5DragAndDrop(page: Page, source: Locator, target: Locator): Promise<void> {
  const sourceHandle = await source.elementHandle();
  const targetHandle = await target.elementHandle();
  if (!sourceHandle) throw new Error('drag source element not found');
  if (!targetHandle) throw new Error('drag target element not found');

  await page.evaluate(
    async ([src, dst]) => {
      const dt = typeof DataTransfer !== 'undefined' ? new DataTransfer() : ({} as DataTransfer);
      const fire = (el: Element, type: string) => {
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(event);
      };

      fire(src, 'dragstart');
      // Let React flush state updates (draggedDoc) before dispatching drop events.
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      fire(dst, 'dragenter');
      fire(dst, 'dragover');
      fire(dst, 'drop');
      fire(src, 'dragend');
    },
    [sourceHandle, targetHandle],
  );
}


// Assert a document link containing the given filename appears in the list
export async function expectDocumentListed(page: Page, fileName: string) {
  const link = page.getByRole('link', { name: new RegExp(escapeRegExp(fileName), 'i') }).first();
  await expect
    .poll(async () => link.count(), { timeout: 20000 })
    .toBeGreaterThan(0);
  await expect(link).toBeVisible({ timeout: 15000 });
}

// Assert a document link containing the given filename does NOT exist
export async function expectNoDocumentLink(page: Page, fileName: string) {
  await expect(
    page.getByRole('link', { name: new RegExp(escapeRegExp(fileName), 'i') })
  ).toHaveCount(0);
}

// Upload multiple files in sequence
export async function uploadFiles(page: Page, ...fileNames: string[]) {
  for (const name of fileNames) {
    await uploadFile(page, name);
    await expectDocumentListed(page, name);
  }
}

// Ensure a set of documents are visible in the list
export async function ensureDocumentsListed(page: Page, fileNames: string[]) {
  for (const name of fileNames) {
    await expectDocumentListed(page, name);
  }
}

// Click the document link row by filename
export async function clickDocumentLink(page: Page, fileName: string) {
  const link = page
    .getByRole('link', { name: new RegExp(escapeRegExp(fileName), 'i') })
    .first();
  await expect(link).toBeVisible({ timeout: 15_000 });

  const href = await link.getAttribute('href');
  if (!href) {
    await link.click();
    return;
  }

  const navigatedByClick = await Promise.all([
    page
      .waitForURL((url) => url.pathname === href, { timeout: 8_000 })
      .then(() => true)
      .catch(() => false),
    link.click(),
  ]).then(([ok]) => ok);

  if (!navigatedByClick) {
    await page.goto(href);
  }
}

// Expect correct URL and viewer to be visible for a given file by extension
export async function expectViewerForFile(page: Page, fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf') || lower.endsWith('.docx')) {
    // DOCX converts to PDF, so viewer expectations are PDF
    await expect(page).toHaveURL(/\/pdf\/[A-Za-z0-9._%-]+$/);
    await waitForPdfViewerReady(page, 60000);
    return;
  }
  if (lower.endsWith('.epub')) {
    await expect(page).toHaveURL(/\/epub\/[A-Za-z0-9._%-]+$/);
    await expect(page.locator('.epub-container')).toBeVisible({ timeout: 15000 });
    return;
  }
  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    await expect(page).toHaveURL(/\/html\/[A-Za-z0-9._%-]+$/);
    await expect(page.locator('.html-container')).toBeVisible({ timeout: 15000 });
    return;
  }
}

// Delete a single document by filename via row action and confirm dialog
export async function deleteDocumentByName(page: Page, fileName: string) {
  await page.getByRole('button', { name: new RegExp(`^Delete\\s+${escapeRegExp(fileName)}$`, 'i') }).first().click();

  const heading = page.getByRole('heading', { name: 'Delete Document' });
  await expect(heading).toBeVisible({ timeout: 10000 });

  const confirmBtn = heading.locator('xpath=ancestor::*[@role="dialog"][1]//button[normalize-space()="Delete"]');
  await confirmBtn.click();
}

// Open Settings modal and navigate to Documents section
export async function openSettingsDocumentsTab(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsDialog = page.locator('[data-testid="settings-modal"]');
  await expect(settingsDialog).toBeVisible({ timeout: 10000 });
  await settingsDialog.getByRole('button', { name: /^Documents$/ }).click();
}

// Open the Voices dropdown from the TTS bar and return the button locator
export async function openVoicesMenu(page: Page) {
  const ttsbar = page.locator('[data-app-ttsbar]');
  await expect(ttsbar).toBeVisible({ timeout: 10000 });

  // If the listbox/options already exist, assume it's open and return (idempotent)
  const alreadyOpen = await page.locator('[role="listbox"], [role="option"]').count();
  if (alreadyOpen > 0) {
    return;
  }

  // Prefer a stable selector using accessible name if present, otherwise fall back to a
  // button whose label matches any known default voice (including "af_" prefixed ones),
  // and finally the last button heuristic.
  const candidateByName = ttsbar.getByRole('button', { name: /Voices|(af_)?(alloy|ash|coral|echo|fable|onyx|nova|sage|shimmer)/i });

  const hasNamed = await candidateByName.count();
  const voicesButton = hasNamed > 0 ? candidateByName.first() : ttsbar.getByRole('button').last();

  await expect(voicesButton).toBeVisible();
  await voicesButton.click();

  // Wait for the options panel to appear; tolerate different render strategies by
  // waiting for either the listbox container or at least one option.
  await Promise.race([
    page.waitForSelector('[role="listbox"]', { timeout: 10000 }),
    page.waitForSelector('[role="option"]', { timeout: 10000 }),
  ]);
}

// Select a voice from the Voices dropdown and assert processing -> playing
export async function selectVoiceAndAssertPlayback(page: Page, voiceName: string | RegExp) {
  // Ensure the menu is open without toggling it closed if already open
  const optionCount = await page.locator('[role="option"]').count();
  if (optionCount === 0) {
    await openVoicesMenu(page);
  }

  await page.getByRole('option', { name: voiceName }).first().click();
  await expectProcessingTransition(page);
}

// Assert skip buttons disabled during processing, then enabled, and playbackState=playing
export async function expectProcessingTransition(page: Page) {
  // Try to detect a brief processing phase where skip buttons are disabled,
  // but tolerate cases where processing completes too quickly to observe.
  const disabledForward = page.locator('button[aria-label="Skip forward"][disabled]');
  const disabledBackward = page.locator('button[aria-label="Skip backward"][disabled]');
  try {
    await Promise.all([
      expect(disabledForward).toBeVisible({ timeout: 3000 }),
      expect(disabledBackward).toBeVisible({ timeout: 3000 }),
    ]);
  } catch {
    // Processing may have completed before we observed disabled state; cause warning but continue
  }

  // Wait for the TTS to stop processing and buttons to be enabled
  await Promise.all([
    page.waitForSelector('button[aria-label="Skip forward"]:not([disabled])', { timeout: 45000 }),
    page.waitForSelector('button[aria-label="Skip backward"]:not([disabled])', { timeout: 45000 }),
  ]);

  // Ensure media session is playing
  await expectMediaState(page, 'playing');
}

// Expect navigator.mediaSession.playbackState to equal given state
export async function expectMediaState(page: Page, state: 'playing' | 'paused') {
  // Engines can intermittently miss mediaSession updates. Accept either:
  // - expected UI control state (Pause button for playing, Play button for paused), or
  // - underlying media state from mediaSession/audio element signals.
  const desiredButtonName = state === 'playing' ? 'Pause' : 'Play';
  await expect
    .poll(async () => {
      const uiMatches = await page
        .getByRole('button', { name: desiredButtonName })
        .first()
        .isVisible()
        .catch(() => false);
      if (uiMatches) return true;

      return page.evaluate((desired) => {
        try {
          const msState = (navigator.mediaSession && navigator.mediaSession.playbackState) || '';
          if (msState === desired) return true;

          const audio: HTMLAudioElement | null = document.querySelector('audio');
          if (audio) {
            const w = window as Window & { __openreaderLastAudioTime?: number };
            const last = w.__openreaderLastAudioTime ?? -1;
            const curr = audio.currentTime;
            w.__openreaderLastAudioTime = curr;

            if (desired === 'playing') {
              if (!audio.paused && curr > 0 && curr > last) return true;
            } else if (audio.paused) {
              return true;
            }
          }
          return false;
        } catch {
          return false;
        }
      }, state);
    }, { timeout: 45000 })
    .toBe(true);
}

// Use Navigator to go to a specific page number (PDF)
export async function navigateToPdfPageViaNavigator(page: Page, targetPage: number) {
  // Navigator popover shows "X / Y"
  const navTrigger = page.getByRole('button', { name: /\d+\s*\/\s*\d+/ });
  await expect(navTrigger).toBeVisible({ timeout: 10000 });
  await navTrigger.click();

  const input = page.getByLabel('Page number');
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill(String(targetPage));
  await input.press('Enter');
}

// Count currently rendered react-pdf Page components
export async function countRenderedPdfPages(page: Page): Promise<number> {
  return await page.locator('.react-pdf__Page').count();
}

// Count currently rendered text layers (active page(s))
export async function countRenderedTextLayers(page: Page): Promise<number> {
  return await page.locator('.react-pdf__Page__textContent').count();
}

// Force viewport resize to trigger resize hooks (e.g., EPUB)
export async function triggerViewportResize(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
}

// Wait for DocumentListState.showHint to persist in IndexedDB 'app-config' store
export async function waitForDocumentListHintPersist(page: Page, expected: boolean) {
  await page.waitForFunction(async (exp) => {
    try {
      const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('openreader-db');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const db = await openDb();
      const readConfig = () => new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(['app-config'], 'readonly');
        const store = tx.objectStore('app-config');
        const getReq = store.get('singleton');
        getReq.onsuccess = () => resolve(getReq.result);
        getReq.onerror = () => reject(getReq.error);
      });
      const item = await readConfig();
      db.close();
      if (!item || typeof item !== 'object') return false;
      const state = (item as { documentListState?: unknown }).documentListState;
      if (!state || typeof state !== 'object') return false;
      const showHint = (state as { showHint?: unknown }).showHint;
      return typeof showHint === 'boolean' && showHint === exp;
    } catch {
      return false;
    }
  }, expected, { timeout: 5000 });
}
