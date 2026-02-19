import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, readFile, readdir, rm, stat } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { randomUUID, createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { safeDocumentName } from '@/lib/server/documents/utils';
import { enqueueDocumentPreview } from '@/lib/server/documents/previews';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import { putDocumentBlob } from '@/lib/server/documents/blobstore';

const DOCSTORE_DIR = path.join(process.cwd(), 'docstore');
const TEMP_DIR = path.join(DOCSTORE_DIR, 'tmp');

async function ensureTempDir() {
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

async function waitForPdfReady(dir: string, timeoutMs = 20000, intervalMs = 100): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const files = await readdir(dir);
    const pdf = files.find((f) => f.toLowerCase().endsWith('.pdf'));
    if (pdf) {
      const pdfPath = path.join(dir, pdf);
      try {
        const first = await stat(pdfPath);
        await new Promise((res) => setTimeout(res, intervalMs));
        const second = await stat(pdfPath);
        if (second.size > 0 && second.size === first.size) {
          return pdfPath;
        }
      } catch {
        // ignore transient errors
      }
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(`PDF not ready in ${dir} after ${timeoutMs}ms`);
}

export async function POST(req: NextRequest) {
  try {
    if (!isS3Configured()) {
      return NextResponse.json(
        { error: 'Documents storage is not configured. Set S3_* environment variables.' },
        { status: 503 },
      );
    }

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const storageUserId = ctxOrRes.userId ?? unclaimedUserId;

    await ensureTempDir();

    const formData = await req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith('.docx')) {
      return NextResponse.json({ error: 'File must be a .docx document' }, { status: 400 });
    }

    const docxBytes = Buffer.from(await file.arrayBuffer());
    // Keep stable IDs tied to source bytes.
    const id = createHash('sha256').update(docxBytes).digest('hex');

    const tempId = randomUUID();
    const jobDir = path.join(TEMP_DIR, tempId);
    await mkdir(jobDir, { recursive: true });
    const profileDir = path.join(jobDir, 'lo-profile');
    await mkdir(profileDir, { recursive: true });
    const inputPath = path.join(jobDir, 'input.docx');

    await writeFile(inputPath, docxBytes);

    try {
      await convertDocxToPdf(inputPath, jobDir, profileDir);
      const pdfPath = await waitForPdfReady(jobDir);
      const pdfContent = await readFile(pdfPath);

      try {
        await putDocumentBlob(id, pdfContent, 'application/pdf', testNamespace);
      } catch (error) {
        // Idempotent behavior: if blob already exists for this sha, continue.
        const maybe = error as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
        const isPreconditionFailed = maybe?.$metadata?.httpStatusCode === 412 || maybe?.name === 'PreconditionFailed';
        if (!isPreconditionFailed) {
          throw error;
        }
      }

      const derivedName = safeDocumentName(`${path.parse(file.name).name}.pdf`, `${id}.pdf`);
      const lastModified = Number.isFinite(file.lastModified) ? file.lastModified : Date.now();

      await db
        .insert(documents)
        .values({
          id,
          userId: storageUserId,
          name: derivedName,
          type: 'pdf',
          size: pdfContent.length,
          lastModified,
          filePath: id,
        })
        .onConflictDoUpdate({
          target: [documents.id, documents.userId],
          set: {
            name: derivedName,
            type: 'pdf',
            size: pdfContent.length,
            lastModified,
            filePath: id,
          },
        });

      await enqueueDocumentPreview(
        {
          id,
          type: 'pdf',
          lastModified,
        },
        testNamespace,
      ).catch((error) => {
        console.error(`Failed to enqueue preview for converted DOCX ${id}:`, error);
      });

      return NextResponse.json({
        stored: {
          id,
          name: derivedName,
          type: 'pdf',
          size: pdfContent.length,
          lastModified,
        },
      });
    } finally {
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    console.error('Error converting/uploading DOCX:', error);
    return NextResponse.json({ error: 'Failed to convert document' }, { status: 500 });
  }
}
