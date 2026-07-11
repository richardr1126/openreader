import { test, expect } from '@playwright/test';
import { uploadFile, uploadAndDisplay, setupTest, expectDocumentListed, uploadFiles, ensureDocumentsListed, clickDocumentLink, expectViewerForFile } from './helpers';

type HashCheckResult =
  | { ok: true; storedId: string; computedId: string }
  | { ok: false; reason: 'Missing stored html document' | 'Hash mismatch' | 'Content fetch failed'; storedId?: string; computedId?: string };

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

  test('reuses the same canonical id for identical uploads', async ({ page }) => {
    await uploadFile(page, 'sample.pdf');
    await uploadFile(page, 'sample.pdf');

    const result = await page.evaluate(async () => {
      const res = await fetch('/api/documents', { cache: 'no-store' });
      if (!res.ok) {
        return { ok: false as const, reason: `status:${res.status}` };
      }
      const data = await res.json() as { documents?: Array<{ id: string; name: string }> };
      const matching = (data.documents || []).filter((doc) => doc.name === 'sample.pdf');
      const uniqueIds = Array.from(new Set(matching.map((doc) => doc.id)));
      return { ok: true as const, matchingCount: matching.length, uniqueIds };
    });

    expect(result.ok).toBeTruthy();
    if (!result.ok) {
      throw new Error(`Failed to inspect uploaded documents: ${result.reason}`);
    }
    expect(result.matchingCount).toBe(1);
    expect(result.uniqueIds).toHaveLength(1);
  });

  test('hashes text/HTML docs using UTF-8 encoded stored string', async ({ page }) => {
    await uploadFile(page, 'sample.txt');
    await expectDocumentListed(page, 'sample.txt');

    const result = await page.evaluate<HashCheckResult>(async () => {
      const listRes = await fetch('/api/documents', { cache: 'no-store' });
      if (!listRes.ok) return { ok: false, reason: 'Content fetch failed' as const };
      const docs = ((await listRes.json()) as { documents?: Array<{ id: string; name: string }> }).documents ?? [];
      const doc = docs.find((item) => item.name === 'sample.txt');
      if (!doc?.id) return { ok: false, reason: 'Missing stored html document' as const };

      const contentRes = await fetch(`/api/documents/blob/get/presign?id=${encodeURIComponent(doc.id)}`, { cache: 'no-store' });
      if (!contentRes.ok) return { ok: false, reason: 'Content fetch failed' as const, storedId: doc.id };
      const digest = await crypto.subtle.digest('SHA-256', await contentRes.arrayBuffer());
      const computedId = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      if (computedId === doc.id) {
        return { ok: true as const, storedId: doc.id, computedId };
      }
      return { ok: false as const, reason: 'Hash mismatch', storedId: doc.id, computedId };
    });

    const detail = result.ok
      ? `Expected storedId=${result.storedId} computedId=${result.computedId}`
      : `Expected valid stored html document but got reason=${result.reason}`;
    expect(result.ok, detail).toBeTruthy();
  });

  test('uploads and converts a DOCX document', async ({ page }) => {
    await uploadFile(page, 'sample.docx');
    // DOCX uploads are normalized into stored PDFs with the same basename.
    await expectDocumentListed(page, 'sample.pdf');
  });

  test('displays a PDF document', async ({ page }) => {
    test.setTimeout(120_000);
    await uploadAndDisplay(page, 'sample.pdf');
    await expectViewerForFile(page, 'sample.pdf');
    // Additional content checks specific to the sample PDF
    await expect(page.getByRole('heading', { level: 1, name: 'sample.pdf' })).toBeVisible();
    await expect(page.getByRole('button', { name: /1\s*\/\s*2/ })).toBeVisible();
  });

  test('displays an EPUB document', async ({ page }) => {
    await uploadAndDisplay(page, 'sample.epub');
    await expectViewerForFile(page, 'sample.epub');
    // Navigation controls should be exposed via accessible labels
    await expect(page.getByRole('button', { name: 'Previous section' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next section' })).toBeVisible();
  });

  test('displays a DOCX document as PDF after conversion', async ({ page }) => {
    test.setTimeout(120_000);
    await uploadAndDisplay(page, 'sample.docx');
    await expectViewerForFile(page, 'sample.docx'); // DOCX converts to PDF
    // Keep specific content checks
    await expect(page.getByText('Demonstration of DOCX')).toBeVisible();
  });

  test('displays a TXT document', async ({ page }) => {
    await uploadAndDisplay(page, 'sample.txt');
    await expectViewerForFile(page, 'sample.txt');
    await expect(page.getByText('Lorem ipsum dolor sit amet')).toBeVisible();
  });

  test('uploads PDF/EPUB/TXT and opens correct viewer for each', async ({ page }) => {
    test.setTimeout(120_000);
    // Upload multiple files
    await uploadFiles(page, 'sample.pdf', 'sample.epub', 'sample.txt');

    // Verify all uploaded files appear in the list
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub', 'sample.txt']);

    // PDF navigation and viewer
    await clickDocumentLink(page, 'sample.pdf');
    await expectViewerForFile(page, 'sample.pdf');
    await page.goBack();
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub', 'sample.txt']);

    // EPUB navigation and viewer
    await clickDocumentLink(page, 'sample.epub');
    await expectViewerForFile(page, 'sample.epub');
    await page.goBack();
    await ensureDocumentsListed(page, ['sample.pdf', 'sample.epub', 'sample.txt']);

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
