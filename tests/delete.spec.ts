import { test } from '@playwright/test';
import { setupTest, uploadFile, expectDocumentListed, expectNoDocumentLink, deleteDocumentByName } from './helpers';

test.describe('Document deletion flow', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
  });

  test('deletes a document and updates list', async ({ page }) => {
    // Upload two documents
    await uploadFile(page, 'sample.pdf');
    await uploadFile(page, 'sample.txt');

    // Verify both appear
    await expectDocumentListed(page, 'sample.pdf');
    await expectDocumentListed(page, 'sample.txt');

    // Delete the TXT document via row action
    await deleteDocumentByName(page, 'sample.txt');

    // Assert the TXT document is removed, PDF remains
    await expectNoDocumentLink(page, 'sample.txt');
    await expectDocumentListed(page, 'sample.pdf');

  });
});
