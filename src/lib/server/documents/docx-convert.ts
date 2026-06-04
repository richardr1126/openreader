import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'url';

const DOCSTORE_DIR = path.join(process.cwd(), 'docstore');
const TEMP_DIR = path.join(DOCSTORE_DIR, 'tmp');

async function ensureTempDir(): Promise<void> {
  if (!existsSync(DOCSTORE_DIR)) {
    await mkdir(DOCSTORE_DIR, { recursive: true });
  }
  if (!existsSync(TEMP_DIR)) {
    await mkdir(TEMP_DIR, { recursive: true });
  }
}

async function convertDocxToPdf(inputPath: string, outputDir: string, profileDir?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];
    if (profileDir) {
      args.push(`-env:UserInstallation=${pathToFileURL(profileDir).toString()}`);
    }
    args.push('--headless', '--nologo', '--convert-to', 'pdf', '--outdir', outputDir, inputPath);
    const proc = spawn('soffice', args);

    proc.on('error', (error) => reject(error));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`LibreOffice conversion failed with code ${code}`));
    });
  });
}

async function waitForPdfReady(dir: string, timeoutMs = 20_000, intervalMs = 100): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const files = await readdir(dir);
    const pdf = files.find((f) => f.toLowerCase().endsWith('.pdf'));
    if (pdf) {
      const pdfPath = path.join(dir, pdf);
      try {
        const first = await stat(pdfPath);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const second = await stat(pdfPath);
        if (second.size > 0 && second.size === first.size) {
          return pdfPath;
        }
      } catch {
        // Ignore transient filesystem races while LibreOffice is still writing.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`PDF not ready in ${dir} after ${timeoutMs}ms`);
}

export async function convertDocxBufferToPdfBuffer(docxBytes: Buffer): Promise<Buffer> {
  await ensureTempDir();

  const tempId = randomUUID();
  const jobDir = path.join(TEMP_DIR, tempId);
  await mkdir(jobDir, { recursive: true });
  const profileDir = path.join(jobDir, 'lo-profile');
  await mkdir(profileDir, { recursive: true });
  const inputPath = path.join(jobDir, 'input.docx');

  try {
    await writeFile(inputPath, docxBytes);
    await convertDocxToPdf(inputPath, jobDir, profileDir);
    const pdfPath = await waitForPdfReady(jobDir);
    return await readFile(pdfPath);
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}
