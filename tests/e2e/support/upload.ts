import type { Page } from '@playwright/test';

export async function uploadLibraryFiles(page: Page, files: string | string[]) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page
    .getByText('Drop your file(s) here, or click to select', { exact: true })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}
