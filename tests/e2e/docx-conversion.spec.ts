import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user converts a DOCX file and reads the resulting PDF', async ({ page }) => {
  test.setTimeout(120_000);
  await enterAnonymousLibrary(page);

  const conversionEventsRequest = page.waitForRequest((request) => (
    new URL(request.url()).pathname === '/api/documents/blob/upload/events'
  ));
  await uploadLibraryFiles(page, resolve('tests/files/sample.docx'));

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
