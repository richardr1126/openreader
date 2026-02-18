import { test, expect } from '@playwright/test';
import path from 'path';
import { readFile } from 'fs/promises';
import {
  renderEpubCoverToJpeg,
  renderPdfFirstPageToJpeg,
} from '../../src/lib/server/documents/previews-render';

test.describe('document-previews-render', () => {
  test('renders first PDF page to JPEG preview', async () => {
    const pdfPath = path.join(process.cwd(), 'tests/files/sample.pdf');
    const bytes = await readFile(pdfPath);
    const rendered = await renderPdfFirstPageToJpeg(bytes, 240);

    expect(rendered.bytes.byteLength).toBeGreaterThan(1024);
    expect(rendered.width).toBe(240);
    expect(rendered.height).toBeGreaterThan(0);
  });

  test('extracts EPUB cover and renders to JPEG preview', async () => {
    const epubPath = path.join(process.cwd(), 'tests/files/sample.epub');
    const bytes = await readFile(epubPath);
    const rendered = await renderEpubCoverToJpeg(bytes, 240);

    expect(rendered.bytes.byteLength).toBeGreaterThan(1024);
    expect(rendered.width).toBe(240);
    expect(rendered.height).toBeGreaterThan(0);
  });
});
