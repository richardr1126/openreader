import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

test('anonymous user converts a DOCX file and reads the resulting PDF', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/app');

  const privacyDialog = page.getByRole('dialog', {
    name: 'Privacy & Data Usage',
    exact: true,
  });
  await privacyDialog
    .getByRole('checkbox', {
      name: 'I have read and agree to the',
      exact: true,
    })
    .check();
  await privacyDialog.getByRole('button', { name: 'Continue', exact: true }).click();

  const backToSettings = page.getByRole('button', {
    name: 'Back to settings',
    exact: true,
  });
  await expect(backToSettings).toBeVisible();
  await backToSettings.click();

  const settingsDialog = page.getByRole('dialog', { name: /^Settings/ });
  const closeSettings = settingsDialog.getByRole('button', {
    name: 'Close dialog',
    exact: true,
  });
  await expect(closeSettings).toBeVisible();
  await closeSettings.click();
  await expect(settingsDialog).toBeHidden();

  const declineOptionalCookies = page.getByRole('button', {
    name: 'Decline Non-Essential',
    exact: true,
  });
  await declineOptionalCookies.click();
  await expect(declineOptionalCookies).toBeHidden();

  const conversionEventsRequest = page.waitForRequest((request) => (
    new URL(request.url()).pathname === '/api/documents/blob/upload/events'
  ));
  const chooserPromise = page.waitForEvent('filechooser');
  await page
    .getByText('Drop your file(s) here, or click to select', { exact: true })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles(resolve('tests/files/sample.docx'));

  await expect(page.getByText('Uploading', { exact: true })).toBeVisible();
  await expect(page.getByText('sample.docx', { exact: true })).toBeVisible();

  const eventsRequest = await conversionEventsRequest;
  const eventsUrl = new URL(eventsRequest.url());
  expect(eventsRequest.method()).toBe('GET');
  expect(eventsUrl.searchParams.get('opId')).toBeTruthy();
  expect(eventsUrl.searchParams.get('token')).toBeTruthy();

  const convertedPdfLink = page.getByRole('link', { name: 'sample.pdf', exact: true });
  await expect(convertedPdfLink).toBeVisible({ timeout: 60_000 });
  await expect(convertedPdfLink).toHaveAttribute('href', /^\/pdf\/[a-f0-9]+$/);
  await expect(page.getByRole('button', { name: 'PDF 1', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('1 item');

  await convertedPdfLink.click();
  await expect(page).toHaveURL(/\/pdf\/[a-f0-9]+$/);
  await expect(
    page.getByRole('heading', { name: 'sample.pdf', exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Demonstration of DOCX support in', { exact: true })).toBeVisible();
  await expect(
    page.getByText('This document demonstrates the ability of the calibre DOCX Input plugin to', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Playback position', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '1 / 8', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
});
