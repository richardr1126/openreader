import { test, expect } from '@playwright/test';
import { uploadFile, uploadAndDisplay, setupTest, expectDocumentListed, uploadFiles, ensureDocumentsListed, clickDocumentLink, expectViewerForFile } from './helpers';

test.describe('Document Upload Tests', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTest(page, testInfo);
  });

  test('uploads a PDF document', async ({ page }) => {
    await uploadFile(page, 'sample.pdf');
    await expectDocumentListed(page, 'sample.pdf');
  });

  test('uploads an EPUB document', async ({ page }) => {
    await uploadFile(page, 'sample.epub');
    await expectDocumentListed(page, 'sample.epub');
  });

  test('uploads a TXT document', async ({ page }) => {
    await uploadFile(page, 'sample.txt');
    await expectDocumentListed(page, 'sample.txt');
  });

  test('hashes text/HTML docs using UTF-8 encoded stored string', async ({ page }) => {
    await uploadFile(page, 'sample.txt');
    await expectDocumentListed(page, 'sample.txt');

    const result = await page.evaluate(async () => {
      const idb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('openreader-db');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

      try {
        const docs = await new Promise<any[]>((resolve, reject) => {
          const tx = idb.transaction('html-documents', 'readonly');
          const store = tx.objectStore('html-documents');
          const request = store.getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result as any[]);
        });

        if (!docs[0]?.data || !docs[0]?.id) {
          return { ok: false, reason: 'Missing stored html document' as const };
        }

        const bytes = new TextEncoder().encode(String(docs[0].data));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const computedId = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');

        return { ok: computedId === docs[0].id, storedId: docs[0].id as string, computedId };
      } finally {
        idb.close();
      }
    });

    expect(result.ok, `Expected storedId=${(result as any).storedId} computedId=${(result as any).computedId}`).toBeTruthy();
  });

  test('uploads and converts a DOCX document', async ({ page }) => {
    await uploadFile(page, 'sample.docx');
    // Should see the converting message (best-effort; conversion may complete extremely fast)
    try {
      await expect(page.getByText('Converting DOCX to PDF...')).toBeVisible({ timeout: 5000 });
    } catch {
      // ignore
    }
    // After conversion, should see the PDF with the same name
    await expectDocumentListed(page, 'sample.pdf');
  });

  test('displays a PDF document', async ({ page }) => {
    await uploadAndDisplay(page, 'sample.pdf');
    await expectViewerForFile(page, 'sample.pdf');
    // Additional content checks specific to the sample PDF
    await expect(page.locator('.react-pdf__Page')).toBeVisible();
    await expect(page.getByText('Sample PDF')).toBeVisible();
  });

  test('displays an EPUB document', async ({ page }) => {
    await uploadAndDisplay(page, 'sample.epub');
    await expectViewerForFile(page, 'sample.epub');
    // Navigation controls should be exposed via accessible labels
    await expect(page.getByRole('button', { name: 'Previous section' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next section' })).toBeVisible();
  });

  test('displays a DOCX document as PDF after conversion', async ({ page }) => {
    await uploadAndDisplay(page, 'sample.docx');
    await expectViewerForFile(page, 'sample.docx'); // DOCX converts to PDF
    // Keep specific content checks
    await expect(page.locator('.react-pdf__Page')).toBeVisible();
    await expect(page.getByText('Demonstration of DOCX')).toBeVisible();
  });

  test('displays a TXT document', async ({ page }) => {
    await uploadAndDisplay(page, 'sample.txt');
    await expectViewerForFile(page, 'sample.txt');
    await expect(page.getByText('Lorem ipsum dolor sit amet')).toBeVisible();
  });

  test('uploads PDF/EPUB/TXT and opens correct viewer for each', async ({ page }) => {
    // Upload multiple files
    await uploadFiles(page, 'sample.pdf', 'sample.epub', 'sample.txt');

    // Verify all uploaded files appear in the list
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub', 'sample.txt']);

    // PDF navigation and viewer
    await clickDocumentLink(page, 'sample.pdf');
    await expectViewerForFile(page, 'sample.pdf');
    await page.goBack();
    await expect(page.getByText('Local Documents')).toBeVisible({ timeout: 10000 });

    // EPUB navigation and viewer
    await clickDocumentLink(page, 'sample.epub');
    await expectViewerForFile(page, 'sample.epub');
    await page.goBack();
    await expect(page.getByText('Local Documents')).toBeVisible({ timeout: 10000 });

    // TXT navigation and viewer (HTML viewer)
    await clickDocumentLink(page, 'sample.txt');
    await expectViewerForFile(page, 'sample.txt');
  });

  test('renders Markdown via ReactMarkdown and keeps TXT preformatted', async ({ page }) => {
    // Upload MD and TXT
    await uploadFiles(page, 'sample.md', 'sample.txt');
    await ensureDocumentsListed(page, ['sample.md', 'sample.txt']);

    // Open MD and verify rendered markdown
    await clickDocumentLink(page, 'sample.md');
    await expectViewerForFile(page, 'sample.md');
    const mdContainer = page.locator('.html-container');
    await expect(mdContainer).toBeVisible();
    // Should have prose classes (not monospace)
    await expect(mdContainer).toHaveClass(/prose/);
    await expect(mdContainer).not.toHaveClass(/font-mono/);
    // Heading and link rendered
    await expect(page.getByRole('heading', { name: 'Sample Markdown' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'OpenAI' })).toBeVisible();

    // Go back and open TXT, verify monospace preformatted
    await page.goBack();
    await clickDocumentLink(page, 'sample.txt');
    await expectViewerForFile(page, 'sample.txt');
    const txtContainer = page.locator('.html-container');
    await expect(txtContainer).toHaveClass(/font-mono/);
  });

  test('unsupported file type is ignored and no new document is created', async ({ page }) => {
    // Capture initial list of names
    const before = await page.locator('.document-link').count();

    // Try to upload unsupported file
    await uploadFile(page, 'unsupported.xyz');
    // Give the UI a moment just in case
    await page.waitForTimeout(500);

    // Assert no new document entries created
    const after = await page.locator('.document-link').count();
    expect(after).toBe(before);
    // Also ensure no link with that filename exists
    await expect(page.getByRole('link', { name: /unsupported\.xyz/i })).toHaveCount(0);
  });
});
