import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { enterAnonymousLibrary } from './support/onboarding';
import { uploadLibraryFiles } from './support/upload';

test('anonymous user receives useful feedback for an unsupported file', async ({ page }) => {
  await enterAnonymousLibrary(page);

  await uploadLibraryFiles(page, resolve('tests/files/unsupported.xyz'));

  await expect(
    page.getByRole('alert').filter({ hasText: 'unsupported.xyz is not supported.' }),
  ).toHaveText('unsupported.xyz is not supported. Choose a PDF, EPUB, TXT, MD, or DOCX file.');
  await expect(
    page.getByRole('link', { name: 'unsupported.xyz', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('0 items');
});
