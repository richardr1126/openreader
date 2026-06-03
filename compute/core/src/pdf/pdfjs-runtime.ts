import fs from 'node:fs';
import path from 'node:path';

let cachedStandardFontDataUrl: string | null = null;

export function resolvePdfjsStandardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;

  const standardFontDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');

  if (!fs.existsSync(standardFontDir)) {
    throw new Error(`pdfjs-dist standard_fonts directory not found at ${standardFontDir}`);
  }

  cachedStandardFontDataUrl = `${standardFontDir.replace(/\/?$/, '/')}`;
  return cachedStandardFontDataUrl;
}
