import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DOCX_CONVERSION_TIMEOUT_MS = 120_000;

async function convertDocxToPdf(inputPath: string, outputDir: string, profileDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      `-env:UserInstallation=${pathToFileURL(profileDir).toString()}`,
      '--headless',
      '--nologo',
      '--convert-to',
      'pdf',
      '--outdir',
      outputDir,
      inputPath,
    ];
    const proc = spawn('soffice', args);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`LibreOffice DOCX conversion timed out after ${DEFAULT_DOCX_CONVERSION_TIMEOUT_MS}ms`));
    }, DEFAULT_DOCX_CONVERSION_TIMEOUT_MS);

    proc.on('error', (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`LibreOffice DOCX conversion failed with code ${code}`));
    });
  });
}

async function waitForPdfReady(dir: string, timeoutMs = 20_000, intervalMs = 100): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const files = await readdir(dir);
    const pdf = files.find((file) => file.toLowerCase().endsWith('.pdf'));
    if (pdf) {
      const pdfPath = path.join(dir, pdf);
      try {
        const first = await stat(pdfPath);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const second = await stat(pdfPath);
        if (second.size > 0 && second.size === first.size) return pdfPath;
      } catch {
        // Ignore transient file-system races while LibreOffice is finishing.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Converted PDF was not ready in ${dir} after ${timeoutMs}ms`);
}

export async function convertDocxBufferToPdfBuffer(docxBytes: Buffer): Promise<Buffer> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'openreader-docx-conversion-'));
  const profileDir = path.join(workDir, 'lo-profile');
  const inputPath = path.join(workDir, 'input.docx');
  try {
    await mkdir(profileDir, { recursive: true });
    await writeFile(inputPath, docxBytes);
    await convertDocxToPdf(inputPath, workDir, profileDir);
    const pdfPath = await waitForPdfReady(workDir);
    return await readFile(pdfPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
