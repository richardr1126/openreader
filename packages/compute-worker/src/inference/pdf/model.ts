import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { access, mkdir, rename, readFile, unlink, copyFile } from 'fs/promises';
import { DOCSTORE_DIR } from '../../infrastructure/platform';
import {
  downloadModelArtifact,
  type ModelDownloadProgressHandler,
} from '../model-download';

const DEFAULT_MODEL_BASE_URL = 'https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX/resolve/main';
const PDF_LAYOUT_MODEL_BASE_URL_ENV = 'PDF_LAYOUT_MODEL_BASE_URL';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = path.join(DOCSTORE_DIR, 'model');
const MANIFEST_PATH = path.join(MODULE_DIR, 'assets', 'manifest.json');
export const MODEL_PATH = path.join(MODEL_DIR, 'PP-DocLayoutV3.onnx');
export const MODEL_DATA_PATH = path.join(MODEL_DIR, 'PP-DocLayoutV3.onnx.data');
export const MODEL_CONFIG_PATH = path.join(MODEL_DIR, 'pp-doclayoutv3.config.json');
export const MODEL_PREPROCESSOR_PATH = path.join(MODEL_DIR, 'pp-doclayoutv3.preprocessor_config.json');
const LICENSE_PATH = path.join(MODEL_DIR, 'pp-doclayoutv3.LICENSE.txt');
const STATIC_LICENSE_PATH = path.join(MODULE_DIR, 'assets', 'LICENSE.txt');

type ManifestEntry = {
  path: string;
  sha256?: string;
  size?: number;
};

function loadManifest(): { files: ManifestEntry[] } {
  const manifestText = readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(manifestText) as { files?: ManifestEntry[] };
  return { files: Array.isArray(parsed.files) ? parsed.files : [] };
}

const manifest = loadManifest();

let inflight: Promise<string> | null = null;
const progressListeners = new Set<ModelDownloadProgressHandler>();

async function sha256Hex(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

function joinModelUrl(baseUrl: string, relativePath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${relativePath}`;
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
    throw new Error('PDF layout model license checksum verification failed');
  }
}

async function publishProgress(downloadedBytes: number, totalBytes: number): Promise<void> {
  await Promise.all([...progressListeners].map((listener) => listener({ downloadedBytes, totalBytes })));
}

async function ensureModelInternal(): Promise<string> {
  try {
    await access(MODEL_PATH);
    await access(MODEL_DATA_PATH);
    await access(MODEL_CONFIG_PATH);
    await access(MODEL_PREPROCESSOR_PATH);
    if (
      await verifyFile(MODEL_PATH, 'model.onnx')
      && await verifyFile(MODEL_DATA_PATH, 'model.onnx.data')
      && await verifyFile(MODEL_CONFIG_PATH, 'config.json')
      && await verifyFile(MODEL_PREPROCESSOR_PATH, 'preprocessor_config.json')
    ) {
      await ensureLicense();
      return MODEL_PATH;
    }
  } catch {
    // continue
  }

  await mkdir(MODEL_DIR, { recursive: true });
  const modelTmpPath = `${MODEL_PATH}.tmp`;
  const modelDataTmpPath = `${MODEL_DATA_PATH}.tmp`;
  const configTmpPath = `${MODEL_CONFIG_PATH}.tmp`;
  const preprocessorTmpPath = `${MODEL_PREPROCESSOR_PATH}.tmp`;
  const modelBaseUrl = process.env[PDF_LAYOUT_MODEL_BASE_URL_ENV]?.trim()
    || DEFAULT_MODEL_BASE_URL;
  const modelUrl = joinModelUrl(modelBaseUrl, 'PP-DocLayoutV3.onnx');
  const modelDataUrl = joinModelUrl(modelBaseUrl, 'PP-DocLayoutV3.onnx.data');
  const configUrl = joinModelUrl(modelBaseUrl, 'config.json');
  const preprocessorUrl = joinModelUrl(modelBaseUrl, 'preprocessor_config.json');

  const downloads = [
    { url: modelUrl, outPath: modelTmpPath, manifestPath: 'model.onnx' },
    { url: modelDataUrl, outPath: modelDataTmpPath, manifestPath: 'model.onnx.data' },
    { url: configUrl, outPath: configTmpPath, manifestPath: 'config.json' },
    { url: preprocessorUrl, outPath: preprocessorTmpPath, manifestPath: 'preprocessor_config.json' },
  ];
  const totalBytes = downloads.reduce((sum, item) => sum + (manifestEntry(item.manifestPath)?.size ?? 0), 0);
  let completedBytes = 0;
  await publishProgress(0, totalBytes);

  const download = async (item: (typeof downloads)[number]) => {
    const expectedBytes = manifestEntry(item.manifestPath)?.size ?? 0;
    const actualBytes = await downloadModelArtifact({
      url: item.url,
      outPath: item.outPath,
      expectedBytes,
      onProgress: ({ downloadedBytes }) => publishProgress(
        Math.min(totalBytes || Number.MAX_SAFE_INTEGER, completedBytes + downloadedBytes),
        totalBytes,
      ),
    });
    completedBytes += expectedBytes || actualBytes;
  };

  await download(downloads[0]);
  if (!(await verifyFile(modelTmpPath, 'model.onnx'))) {
    await unlink(modelTmpPath).catch(() => undefined);
    throw new Error('PDF layout model checksum verification failed');
  }
  await download(downloads[1]);
  if (!(await verifyFile(modelDataTmpPath, 'model.onnx.data'))) {
    await unlink(modelDataTmpPath).catch(() => undefined);
    throw new Error('PDF layout model external data checksum verification failed');
  }
  await download(downloads[2]);
  if (!(await verifyFile(configTmpPath, 'config.json'))) {
    await unlink(configTmpPath).catch(() => undefined);
    throw new Error('PDF layout model config checksum verification failed');
  }
  await download(downloads[3]);
  if (!(await verifyFile(preprocessorTmpPath, 'preprocessor_config.json'))) {
    await unlink(preprocessorTmpPath).catch(() => undefined);
    throw new Error('PDF layout model preprocessor checksum verification failed');
  }

  await rename(modelTmpPath, MODEL_PATH);
  await rename(modelDataTmpPath, MODEL_DATA_PATH);
  await rename(configTmpPath, MODEL_CONFIG_PATH);
  await rename(preprocessorTmpPath, MODEL_PREPROCESSOR_PATH);
  await ensureLicense();
  return MODEL_PATH;
}

export async function ensureModel(options: { onProgress?: ModelDownloadProgressHandler } = {}): Promise<string> {
  if (options.onProgress) progressListeners.add(options.onProgress);
  if (!inflight) {
    inflight = ensureModelInternal().finally(() => {
      inflight = null;
    });
  }
  try {
    return await inflight;
  } finally {
    if (options.onProgress) progressListeners.delete(options.onProgress);
  }
}
