import { test, expect } from '@playwright/test';
import {
  setupTest,
  playTTSAndWaitForASecond,
  openVoicesMenu,
  selectVoiceAndAssertPlayback,
  expectMediaState,
  expectProcessingTransition,
} from './helpers';

// Single-spec helpers kept local instead of living in shared helpers:
async function pauseTTSAndVerify(page: any) {
  // Click pause to stop playback
  await page.getByRole('button', { name: 'Pause' }).click();
  // Check for play button to be visible
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 10000 });
}

async function openSpeedPopover(page: any) {
  const ttsbar = page.locator('[data-app-ttsbar]');
  const buttons = ttsbar.getByRole('button');
  // Heuristic: the Speed control is the first button in the TTS bar and shows something like "1x"
  const speedBtn = buttons.first();
  await expect(speedBtn).toBeVisible({ timeout: 10000 });
  await speedBtn.click();
  // Popover panel should appear with sliders
  await page.waitForSelector('input[type="range"]', { timeout: 10000 });
}

async function changeNativeSpeedAndAssert(page: any, newSpeed: number) {
  await openSpeedPopover(page);
  const slider = page.locator('input[type="range"]').first();

  // Set the slider value programmatically and dispatch events to trigger handlers
  const valueStr = String(newSpeed);
  await slider.evaluate((input: HTMLInputElement, v: string) => {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('mouseup', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
    input.dispatchEvent(new Event('touchend', { bubbles: true }));
  }, valueStr);

  await expectProcessingTransition(page);
}

test.describe('Play/Pause Tests', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
  });

  test.describe.configure({ mode: 'serial', timeout: 60000 });

  test('plays and pauses TTS for a PDF document', async ({ page }) => {
    // Play TTS for the PDF document
    await playTTSAndWaitForASecond(page, 'sample.pdf');
    
    // Pause TTS and verify paused state
    await pauseTTSAndVerify(page);
  });

  test('plays and pauses TTS for an EPUB document', async ({ page }) => {
    // Play TTS for the EPUB document
    await playTTSAndWaitForASecond(page, 'sample.epub');
    
    // Pause TTS and verify paused state
    await pauseTTSAndVerify(page);
  });

  test('plays and pauses TTS for an DOCX document', async ({ page }) => {
    // Play TTS for the DOCX document
    await playTTSAndWaitForASecond(page, 'sample.docx');
    
    // Pause TTS and verify paused state
    await pauseTTSAndVerify(page);
  });

  test('plays and pauses TTS for a TXT document', async ({ page }) => {
    // Play TTS for the TXT document
    await playTTSAndWaitForASecond(page, 'sample.txt');
    
    // Pause TTS and verify paused state
    await pauseTTSAndVerify(page);
  });

  test('switches to a single voice and resumes playing', async ({ page }) => {
    // Start playback
    await playTTSAndWaitForASecond(page, 'sample.pdf');

    // Ensure basic TTS controls are present
    await expect(page.getByRole('button', { name: 'Skip backward' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip forward' })).toBeVisible();

    // Open voices list and assert options render
    await openVoicesMenu(page);
    const options = page.getByRole('option');
    expect(await options.count()).toBeGreaterThan(0);

    await selectVoiceAndAssertPlayback(page, 'af_bella');
    //await expectProcessingTransition(page);

    // Final state should be playing
    await expectMediaState(page, 'playing');
  });

  if (!process.env.CI) test('selects multiple Kokoro voices and resumes playing', async ({ page }) => {
    // Start playback
    await playTTSAndWaitForASecond(page, 'sample.pdf');

    // Ensure TTS controls are present
    await expect(page.getByRole('button', { name: 'Skip backward' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip forward' })).toBeVisible();

    // Select first voice (e.g., bf_emma) and assert processing -> playing
    await openVoicesMenu(page);
    await selectVoiceAndAssertPlayback(page, 'bf_emma');

    // Select second voice (e.g., af_heart) to create a multi-voice mix and assert again
    await openVoicesMenu(page);
    await selectVoiceAndAssertPlayback(page, 'af_heart');

    // Final state should be playing
    await expectMediaState(page, 'playing');
  });

  test('changing TTS native speed toggles processing and returns to playing', async ({ page }) => {
    await playTTSAndWaitForASecond(page, 'sample.pdf');
    await changeNativeSpeedAndAssert(page, 1.5);
    await expectMediaState(page, 'playing');
  });
});
