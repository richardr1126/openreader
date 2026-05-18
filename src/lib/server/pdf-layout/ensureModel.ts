import path from 'path';
import { createHash } from 'crypto';
import { access, mkdir, rename, writeFile, readFile, unlink, copyFile } from 'fs/promises';
import { DOCSTORE_DIR } from '@/lib/server/storage/library-mount';
import manifest from '@/lib/server/pdf-layout/model/manifest.json';

const DEFAULT_MODEL_URL = 'https://huggingface.co/docling-project/docling-layout-heron-onnx/resolve/main/model.onnx';
const DEFAULT_CONFIG_URL = 'https://huggingface.co/docling-project/docling-layout-heron-onnx/resolve/main/config.json';
const MODEL_DIR = path.join(DOCSTORE_DIR, 'model');
const MODEL_PATH = path.join(MODEL_DIR, 'docling-layout-heron.onnx');
const CONFIG_PATH = path.join(MODEL_DIR, 'docling-layout-heron.config.json');
const LICENSE_PATH = path.join(MODEL_DIR, 'docling-layout-heron.LICENSE.txt');
const STATIC_LICENSE_PATH = path.join(process.cwd(), 'src/lib/server/pdf-layout/model/LICENSE.txt');

let inflight: Promise<string> | null = null;

async function sha256Hex(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function downloadToFile(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed for ${url}: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(outPath, bytes);
}

function manifestEntry(filePath: string): { sha256: string; size: number } | null {
  const found = manifest.files.find((entry) => entry.path === filePath);
  if (!found || !found.sha256) return null;
  return {
    sha256: found.sha256.toLowerCase(),
    size: Number(found.size),
  };
}

async function verifyFile(pathToFile: string, manifestPath: string): Promise<boolean> {
  const expected = manifestEntry(manifestPath);
  if (!expected) return true;
  const bytes = await readFile(pathToFile);
  if (Number.isFinite(expected.size) && expected.size > 0 && bytes.byteLength !== expected.size) {
    return false;
  }
  const actual = await sha256Hex(pathToFile);
  return actual === expected.sha256;
}

async function ensureLicense(): Promise<void> {
  await copyFile(STATIC_LICENSE_PATH, LICENSE_PATH);
  if (!(await verifyFile(LICENSE_PATH, 'LICENSE.txt'))) {
    throw new Error('Docling model license checksum verification failed');
  }
}

async function ensureModelInternal(): Promise<string> {
  try {
    await access(MODEL_PATH);
    await access(CONFIG_PATH);
    if (await verifyFile(MODEL_PATH, 'model.onnx') && await verifyFile(CONFIG_PATH, 'config.json')) {
      await ensureLicense();
      return MODEL_PATH;
    }
  } catch {
    // continue
  }

  await mkdir(MODEL_DIR, { recursive: true });
  const tmpPath = `${MODEL_PATH}.tmp`;
  const configTmpPath = `${CONFIG_PATH}.tmp`;
  const modelUrl = process.env.OPENREADER_DOCLING_MODEL_URL?.trim() || DEFAULT_MODEL_URL;
  const configUrl = process.env.OPENREADER_DOCLING_CONFIG_URL?.trim() || DEFAULT_CONFIG_URL;

  await downloadToFile(modelUrl, tmpPath);
  if (!(await verifyFile(tmpPath, 'model.onnx'))) {
    await unlink(tmpPath).catch(() => undefined);
    throw new Error('Docling model checksum verification failed');
  }
  await downloadToFile(configUrl, configTmpPath);
  if (!(await verifyFile(configTmpPath, 'config.json'))) {
    await unlink(configTmpPath).catch(() => undefined);
    throw new Error('Docling model config checksum verification failed');
  }

  await rename(tmpPath, MODEL_PATH);
  await rename(configTmpPath, CONFIG_PATH);
  await ensureLicense();
  return MODEL_PATH;
}

export async function ensureModel(): Promise<string> {
  if (inflight) return inflight;
  inflight = ensureModelInternal().finally(() => {
    inflight = null;
  });
  return inflight;
}
