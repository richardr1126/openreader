import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cachedStandardFontDataUrl: string | null = null;

export function resolvePdfjsStandardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;

  const pdfjsEntry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjsPackageRoot = path.resolve(path.dirname(pdfjsEntry), '..', '..');
  const standardFontDir = path.join(pdfjsPackageRoot, 'standard_fonts');

  if (!fs.existsSync(standardFontDir)) {
    throw new Error(`pdfjs-dist standard_fonts directory not found at ${standardFontDir}`);
  }

  cachedStandardFontDataUrl = `${standardFontDir.replace(/\/?$/, '/')}`;
  return cachedStandardFontDataUrl;
}
