import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let cachedStandardFontDataUrl: string | null = null;
const pdfjsPackageName = 'pdfjs-dist';

function candidatePackageRoots(): string[] {
  const roots = new Set<string>();
  let dir = process.cwd();

  for (let i = 0; i < 8; i += 1) {
    roots.add(path.join(dir, 'node_modules', pdfjsPackageName));
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }

  return [...roots];
}

function resolvePdfjsPackageFile(relativePath: string): string {
  const normalizedRelativePath = relativePath.replace(/^\/+/, '');
  const candidates = candidatePackageRoots().map((root) => path.join(root, normalizedRelativePath));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;

  throw new Error(
    `pdfjs-dist file not found: ${normalizedRelativePath}; checked ${candidates.join(', ')}`,
  );
}

export function resolvePdfjsStandardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;

  const pdfjsPackageDir = path.dirname(resolvePdfjsPackageFile('package.json'));
  const standardFontDir = path.join(pdfjsPackageDir, 'standard_fonts');

  if (!fs.existsSync(standardFontDir)) {
    throw new Error(`pdfjs-dist standard_fonts directory not found at ${standardFontDir}`);
  }

  cachedStandardFontDataUrl = `${standardFontDir.replace(/\/?$/, '/')}`;
  return cachedStandardFontDataUrl;
}

export function resolvePdfjsWorkerSrc(): string {
  return pathToFileURL(resolvePdfjsPackageFile('legacy/build/pdf.worker.mjs')).href;
}

export function configurePdfjsNodeRuntime(pdfjs: {
  GlobalWorkerOptions?: {
    workerSrc?: string;
    workerPort?: unknown;
  };
}): void {
  if (!pdfjs.GlobalWorkerOptions) return;
  pdfjs.GlobalWorkerOptions.workerSrc = resolvePdfjsWorkerSrc();
  pdfjs.GlobalWorkerOptions.workerPort = null;
}
