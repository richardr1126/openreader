import { Page, expect, type TestInfo, type Locator } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const DIR = './tests/files/';
const TTS_MOCK_PATH = path.join(__dirname, 'files', 'sample.mp3');
let ttsMockBuffer: Buffer | null = null;

function isAuthEnabledForTests() {
  return Boolean(process.env.AUTH_SECRET && process.env.BASE_URL);
}

async function ensureTtsRouteMock(page: Page) {
  if (!ttsMockBuffer) {
    ttsMockBuffer = fs.readFileSync(TTS_MOCK_PATH);
  }

  await page.route('**/api/tts', async (route) => {
    // Only mock the POST TTS generation calls; let anything else pass through.
    if (route.request().method().toUpperCase() !== 'POST') {
      return route.continue();
    }

    await route.fulfill({
      status: 200,
      contentType: 'audio/mpeg',
      body: ttsMockBuffer as Buffer,
    });
  });
}

// Small util to safely use filenames inside regex patterns
function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fixturePath(fileName: string) {
  return path.join(__dirname, 'files', fileName);
}

function sha256HexOfFile(filePath: string) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Upload a sample epub or pdf
 */
export async function uploadFile(page: Page, filePath: string) {
  const input = page.locator('input[type=file]').first();
  await expect(input).toBeVisible({ timeout: 10000 });
  await expect(input).toBeEnabled({ timeout: 10000 });

  await input.setInputFiles(`${DIR}${filePath}`);

  // Wait for the uploader to finish processing. The input is disabled while
  // uploading/converting via react-dropzone's `disabled` prop.
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
    // Best-effort: conversion can complete before we observe this UI state.
    try {
      await expect(page.getByText('Converting DOCX to PDF...')).toBeVisible({ timeout: 5000 });
    } catch {
      // ignore
    }
    const expectedId = sha256HexOfFile(fixturePath(fileName));
    const targetLink = page.locator(`a[href$="/pdf/${expectedId}"]`).first();
    await expect(targetLink).toBeVisible({ timeout: 15000 });
    await targetLink.click();
    await page.waitForSelector('.react-pdf__Document', { timeout: 15000 });
    return;
  }

  await page.getByRole('link', { name: new RegExp(escapeRegExp(fileName), 'i') }).first().click();

  if (lower.endsWith('.pdf')) {
    await page.waitForSelector('.react-pdf__Document', { timeout: 10000 });
  } else if (lower.endsWith('.epub')) {
    await page.waitForSelector('.epub-container', { timeout: 10000 });
  } else if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    await page.waitForSelector('.html-container', { timeout: 10000 });
  }
}

/**
 * Wait for the play button to be clickable and click it
 */
export async function waitAndClickPlay(page: Page) {
  // Wait for play button selector without disabled attribute
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  // Play the TTS by clicking the button
  await page.getByRole('button', { name: 'Play' }).click();
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
  // Click pause to stop playback
  await page.getByRole('button', { name: 'Pause' }).click();

  // Check for play button to be visible
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 10000 });
}

/**
 * Common test setup function
 */
export async function setupTest(page: Page, testInfo?: TestInfo) {
  const namespace = testInfo ? `${testInfo.project.name}-worker${testInfo.workerIndex}` : null;
  if (namespace) {
    // Isolate server-side storage per Playwright worker to avoid cross-test flake
    // when running with multiple workers (server-first document storage).
    await page.context().setExtraHTTPHeaders({ 'x-openreader-test-namespace': namespace });
  }

  // In no-auth mode, all tests in a worker share the same server-side unclaimed identity.
  // Clear docs at setup to avoid cross-test collisions on duplicate filenames.
  if (!isAuthEnabledForTests()) {
    const headers = namespace ? { 'x-openreader-test-namespace': namespace } : undefined;
    let cleared = false;
    let authProtected = false;
    let attempts = 0;
    while (!cleared && attempts < 3) {
      attempts += 1;
      try {
        const res = await page.request.delete('/api/documents', { ...(headers ? { headers } : {}) });
        // If this endpoint requires auth, we're not in no-auth mode for this run.
        // Skip cleanup rather than hard-failing setup.
        if (res.status() === 401 || res.status() === 403) {
          authProtected = true;
          break;
        }
        if (res.ok()) {
          cleared = true;
          break;
        }
      } catch {
        // retry
      }
      await page.waitForTimeout(200);
    }
    if (!cleared && !authProtected) {
      throw new Error('Failed to clear server documents before test setup');
    }
  }

  // Mock the TTS API so tests don't hit the real TTS service.
  await ensureTtsRouteMock(page);

  // Pre-seed consent to prevent the cookie banner from blocking interactions.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('cookie-consent', 'accepted');
    } catch {
      // ignore storage errors in restricted contexts
    }
  });

  // If auth is enabled, establish an anonymous session BEFORE navigation.
  // This keeps each test self-contained (no shared storageState) while ensuring
  // server routes that require auth don't intermittently 401 during app startup.
  // await ensureAnonymousSession(page);

  // Navigate to the protected app home before each test
  await page.goto('/app');
  await page.waitForLoadState('networkidle');

  // AuthLoader may show a full-screen overlay while session is loading.
  // Wait for it to be gone before interacting with underlying UI.
  await page
    .waitForSelector('.fixed.inset-0.bg-base.z-50', { state: 'detached', timeout: 15_000 })
    .catch(() => { });

  // Privacy modal should come first in onboarding.
  // Be tolerant if it's already accepted (e.g., reused context).
  const privacyBtn = page.getByRole('button', { name: /Continue|I Understand/i });
  try {
    await expect(privacyBtn).toBeVisible({ timeout: 5000 });
    const privacyAgree = page.locator('#privacy-agree');
    if ((await privacyAgree.count()) > 0) {
      await privacyAgree.check();
    }
    await expect(privacyBtn).toBeEnabled({ timeout: 5000 });
    await privacyBtn.click();
    // HeadlessUI keeps dialogs in the DOM during leave transitions; "hidden" is enough
    // (we mainly need to ensure it no longer blocks pointer events).
    await page.getByRole('dialog', { name: /privacy/i }).waitFor({ state: 'hidden', timeout: 15000 });
  } catch {
    // ignore
  }

  // Fallback: if the banner still appears, dismiss it before continuing.
  const cookieAcceptBtn = page.getByRole('button', { name: 'Accept All' });
  if (await cookieAcceptBtn.isVisible().catch(() => false)) {
    await cookieAcceptBtn.click();
  }

  // Settings modal should appear after privacy acceptance on first visit.
  const saveBtn = page.getByRole('button', { name: 'Save' });
  await expect(saveBtn).toBeVisible({ timeout: 10000 });
  // SettingsModal can briefly disable Save while it mirrors a custom model into the input field.
  await expect(saveBtn).toBeEnabled({ timeout: 15000 });

  // If running in CI, select the "Custom OpenAI-Like" model and "Deepinfra" provider
  if (process.env.CI) {
    await page.getByRole('button', { name: 'Custom OpenAI-Like' }).click();
    await page.getByText('Deepinfra').click();
  }

  // Click the "done" button to dismiss the welcome message
  await saveBtn.click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'hidden', timeout: 15000 });
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
  await expect(
    page.getByRole('link', { name: new RegExp(escapeRegExp(fileName), 'i') }).first()
  ).toBeVisible({ timeout: 10000 });
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
  await page
    .getByRole('link', { name: new RegExp(escapeRegExp(fileName), 'i') })
    .first()
    .click();
}

// Expect correct URL and viewer to be visible for a given file by extension
export async function expectViewerForFile(page: Page, fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf') || lower.endsWith('.docx')) {
    // DOCX converts to PDF, so viewer expectations are PDF
    await expect(page).toHaveURL(/\/pdf\/[A-Za-z0-9._%-]+$/);
    await expect(page.locator('.react-pdf__Document')).toBeVisible({ timeout: 15000 });
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
  const link = page.getByRole('link', { name: new RegExp(escapeRegExp(fileName), 'i') }).first();
  await link.locator('xpath=..').getByRole('button', { name: 'Delete document' }).click();

  const heading = page.getByRole('heading', { name: 'Delete Document' });
  await expect(heading).toBeVisible({ timeout: 10000 });

  const confirmBtn = heading.locator('xpath=ancestor::*[@role="dialog"][1]//button[normalize-space()="Delete"]');
  await confirmBtn.click();
}

// Open Settings modal and navigate to Documents tab
export async function openSettingsDocumentsTab(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: '📄 Docs' }).click();
}

// Delete all local documents through Settings and close dialogs
export async function deleteAllLocalDocuments(page: Page) {
  await openSettingsDocumentsTab(page);
  await page.getByRole('button', { name: /Delete (anonymous docs|all user docs|server docs)/i }).click();

  const heading = page.getByRole('heading', { name: /Delete (Anonymous Docs|All User Docs|Server Docs)/i });
  await expect(heading).toBeVisible({ timeout: 10000 });

  const confirmBtn = heading.locator('xpath=ancestor::*[@role="dialog"][1]//button[normalize-space()="Delete"]');
  await confirmBtn.click();

  // Close any remaining modal layers
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
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
  // WebKit (and sometimes other engines) may not reliably update navigator.mediaSession.playbackState.
  // Fallback heuristics:
  // 1. Prefer mediaSession if it matches desired state.
  // 2. Otherwise inspect any <audio> element: use paused flag and currentTime progression.
  // 3. Allow short grace period for first frame to advance.
  // 4. If neither detectable, keep polling until timeout.
  await page.waitForFunction((desired) => {
    try {
      const msState = (navigator.mediaSession && navigator.mediaSession.playbackState) || '';
      if (msState === desired) return true;

      const audio: HTMLAudioElement | null = document.querySelector('audio');
      if (audio) {
        // Track advancement by storing last time on the element dataset
        const last = parseFloat(audio.dataset.lastTime || '0');
        const curr = audio.currentTime;
        audio.dataset.lastTime = String(curr);

        if (desired === 'playing') {
          // Consider playing if not paused AND time has advanced at least a tiny amount
          if (!audio.paused && curr > 0 && curr > last) return true;
        } else {
          // paused target
          if (audio.paused) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }, state);
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
