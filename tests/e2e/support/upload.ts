import { basename } from 'node:path';

import { expect, type Page } from '@playwright/test';

export async function uploadLibraryFiles(
  page: Page,
  files: string | string[],
  options: { waitForLibraryEntries?: boolean } = {},
) {
  const paths = Array.isArray(files) ? files : [files];
  const chooserPromise = page.waitForEvent('filechooser');
  await page
    .getByText('Drop your file(s) here, or click to select', { exact: true })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);

  if (options.waitForLibraryEntries === false) return;
  await Promise.all(paths.map((path) =>
    expect(page.getByRole('link', { name: basename(path), exact: true })).toBeVisible({
      timeout: 30_000,
    }),
  ));
}
