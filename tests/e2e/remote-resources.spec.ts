import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

const REMOTE_HOST = 'remote-resource.invalid';

test('opening local documents never requests their remote resources', async ({ page }) => {
  test.setTimeout(75_000);
  const remoteRequests: string[] = [];
  // A route sees only requests that reach the network. Chromium also reports
  // requests its Content Security Policy refused, which never leave the page.
  await page.context().route(`https://${REMOTE_HOST}/**`, (route) => {
    remoteRequests.push(route.request().url());
    return route.abort();
  });
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, [
    resolve('tests/files/remote-resources.epub'),
    resolve('tests/files/remote-image.md'),
  ]);

  await page.getByRole('link', { name: 'remote-resources.epub', exact: true }).click();
  await expect(page).toHaveURL(/\/epub\/[a-f0-9]+$/);
  const book = page.frameLocator('iframe');
  await expect(book.getByRole('heading', { name: 'The Lighthouse', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  // The illustration packaged with the book still renders.
  const illustration = book.getByRole('img', { name: 'Packaged illustration', exact: true });
  await expect.poll(() => illustration.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  expect(remoteRequests).toEqual([]);

  await page.goBack();
  await page.getByRole('link', { name: 'remote-image.md', exact: true }).click();
  await expect(page).toHaveURL(/\/html\/[a-f0-9]+$/);
  await expect(page.getByText('The lamp turned through the night.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const remoteImage = page.getByRole('img', { name: 'Remote [pixel] image', exact: true });
  await expect(remoteImage).toHaveCount(0);
  expect(remoteRequests).toEqual([]);

  // Loading images applies to this visit; reopening hides them again.
  const imagesBar = page.getByRole('group', { name: 'Remote images', exact: true });
  await imagesBar.getByRole('button', { name: 'Load images', exact: true }).click();
  await expect(remoteImage).toHaveCount(1);
  await expect.poll(() => remoteRequests).toContain(`https://${REMOTE_HOST}/pixel.png`);
  await page.reload();
  await expect(page.getByText('The lamp turned through the night.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(remoteImage).toHaveCount(0);

  // Always loading them is a reader setting that persists.
  await imagesBar.getByRole('button', { name: 'Always load', exact: true }).click();
  await expect(remoteImage).toHaveCount(1);
  await page.reload();
  await expect(remoteImage).toHaveCount(1, { timeout: 30_000 });
  await expect(imagesBar).toHaveCount(0);
  await page.goto('/app/settings?section=customize');
  await expect(page.getByRole('switch', { name: 'Load remote images', exact: true })).toBeChecked();
});
