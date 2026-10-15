import path from 'path';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { access, copyFile, mkdir, readFile, rename, unlink } from 'fs/promises';
import { DOCSTORE_DIR } from '../../infrastructure/platform';
import { resolveWorkerPath } from '../../worker-paths';
import {
  downloadModelArtifact,
  type ModelDownloadProgressHandler,
} from '../model-download';

const ASSETS_DIR = resolveWorkerPath('inference', 'whisper', 'assets');
const STATIC_LICENSE_PATH = path.join(ASSETS_DIR, 'LICENSE.txt');
const BASE_MANIFEST_PATH = path.join(ASSETS_DIR, 'manifest.json');
const TINY_EN_MANIFEST_PATH = path.join(ASSETS_DIR, 'tiny-en-manifest.json');

export type WhisperModelVariant = 'base-multilingual' | 'tiny-english';

type WhisperModelSpec = {
  directoryName: string;
  manifestPath: string;
  baseUrl: string;
};

const MODEL_SPECS: Record<WhisperModelVariant, WhisperModelSpec> = {
  'base-multilingual': {
    directoryName: 'whisper-base_timestamped',
    manifestPath: BASE_MANIFEST_PATH,
    baseUrl: 'https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/main',
  },
  'tiny-english': {
    directoryName: 'whisper-tiny.en_timestamped',
    manifestPath: TINY_EN_MANIFEST_PATH,
    baseUrl: 'https://huggingface.co/onnx-community/whisper-tiny.en_timestamped/resolve/aeaa13760958b03fac5062f457d317d3319c3168',
  },
};

const WHISPER_MODEL_BASE_URL_ENV = 'WHISPER_MODEL_BASE_URL';

type ManifestEntry = { path: string; sha256?: string; size?: number };

export interface WhisperArtifactSpec {
  path: string;
  sha256?: string;
  size?: number;
  url: string;
}

export interface WhisperStaticArtifactSpec {
  path: string;
  sha256?: string;
  size?: number;
  sourcePath: string;
}

export type WhisperFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function loadManifestFiles(manifestPath: string): ManifestEntry[] {
  const manifestText = readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(manifestText) as { files?: ManifestEntry[] };
  return Array.isArray(parsed.files) ? parsed.files : [];
}

function normalizeExpected(entry: { sha256?: string; size?: number }): { sha256: string | null; size: number } {
  return {
    sha256: typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : null,
    size: Number(entry.size ?? 0),
  };
}

function resolvePath(relativePath: string, modelDir: string): string {
  return path.join(modelDir, relativePath);
}

function joinModelUrl(baseUrl: string, relativePath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${relativePath}`;
}

function resolveUrl(variant: WhisperModelVariant, relativePath: string): string {
  const overrideBase = variant === 'base-multilingual'
    ? process.env[WHISPER_MODEL_BASE_URL_ENV]?.trim()
    : null;
  return joinModelUrl(overrideBase || MODEL_SPECS[variant].baseUrl, relativePath);
}

function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyBytes(bytes: Uint8Array, expected: { sha256?: string; size?: number }): boolean {
  const normalized = normalizeExpected(expected);
  if (Number.isFinite(normalized.size) && normalized.size > 0 && bytes.byteLength !== normalized.size) {
    return false;
  }
  if (!normalized.sha256) return true;
  return sha256OfBytes(bytes) === normalized.sha256;
}

async function verifyFile(filePath: string, expected: { sha256?: string; size?: number }): Promise<boolean> {
  const bytes = await readFile(filePath);
  return verifyBytes(bytes, expected);
}

export async function ensureWhisperArtifacts(options: {
  modelDir: string;
  artifacts: WhisperArtifactSpec[];
  staticArtifacts?: WhisperStaticArtifactSpec[];
  fetchImpl?: WhisperFetch;
  onProgress?: ModelDownloadProgressHandler;
}): Promise<void> {
  const {
    modelDir,
    artifacts,
    staticArtifacts = [],
    fetchImpl = fetch,
    onProgress,
  } = options;

  try {
    await Promise.all(artifacts.map(async (artifact) => {
      const target = resolvePath(artifact.path, modelDir);
      await access(target);
      const valid = await verifyFile(target, artifact);
      if (!valid) {
        throw new Error(`Checksum mismatch for existing Whisper artifact: ${artifact.path}`);
      }
    }));

    await Promise.all(staticArtifacts.map(async (artifact) => {
      const target = resolvePath(artifact.path, modelDir);
      await access(target);
      const valid = await verifyFile(target, artifact);
      if (!valid) {
        throw new Error(`Checksum mismatch for existing Whisper static artifact: ${artifact.path}`);
      }
    }));

    return;
  } catch {
    // Continue to repair/download.
  }

  const totalBytes = artifacts.reduce((sum, artifact) => sum + Math.max(0, Number(artifact.size ?? 0)), 0);
  let completedBytes = 0;
  await onProgress?.({ downloadedBytes: 0, totalBytes });

  for (const artifact of artifacts) {
    const target = resolvePath(artifact.path, modelDir);
    const targetDir = path.dirname(target);
    const tmp = `${target}.tmp`;

    await mkdir(targetDir, { recursive: true });
    const expectedBytes = Math.max(0, Number(artifact.size ?? 0));
    const actualBytes = await downloadModelArtifact({
      fetchImpl,
      url: artifact.url,
      outPath: tmp,
      expectedBytes,
      onProgress: ({ downloadedBytes }) => onProgress?.({
        downloadedBytes: Math.min(totalBytes || Number.MAX_SAFE_INTEGER, completedBytes + downloadedBytes),
        totalBytes,
      }),
    });
    if (!(await verifyFile(tmp, artifact))) {
      await unlink(tmp).catch(() => undefined);
      throw new Error(`Whisper artifact checksum verification failed: ${artifact.path}`);
    }
    await rename(tmp, target);
    completedBytes += expectedBytes || actualBytes;
  }

  for (const artifact of staticArtifacts) {
    const target = resolvePath(artifact.path, modelDir);
    const targetDir = path.dirname(target);
    await mkdir(targetDir, { recursive: true });
    await copyFile(artifact.sourcePath, target);
    if (!(await verifyFile(target, artifact))) {
      throw new Error(`Whisper static artifact checksum verification failed: ${artifact.path}`);
    }
  }
}

export function resolveWhisperModelVariant(language?: string): WhisperModelVariant {
  const baseLanguage = language?.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  return baseLanguage === 'en' ? 'tiny-english' : 'base-multilingual';
}

export type WhisperModelPaths = {
  modelDir: string;
  configPath: string;
  generationConfigPath: string;
  tokenizerPath: string;
  tokenizerConfigPath: string;
  encoderModelPath: string;
  decoderMergedModelPath: string;
  decoderWithPastModelPath: string;
};

export function getWhisperModelPaths(variant: WhisperModelVariant): WhisperModelPaths {
  const modelDir = path.join(DOCSTORE_DIR, 'model', MODEL_SPECS[variant].directoryName);
  return {
    modelDir,
    configPath: path.join(modelDir, 'config.json'),
    generationConfigPath: path.join(modelDir, 'generation_config.json'),
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    tokenizerConfigPath: path.join(modelDir, 'tokenizer_config.json'),
    encoderModelPath: path.join(modelDir, 'onnx', 'encoder_model_q4.onnx'),
    decoderMergedModelPath: path.join(modelDir, 'onnx', 'decoder_model_merged_q4.onnx'),
    decoderWithPastModelPath: path.join(modelDir, 'onnx', 'decoder_with_past_model_q4.onnx'),
  };
}

async function ensureModelInternal(
  variant: WhisperModelVariant,
  onProgress?: ModelDownloadProgressHandler,
): Promise<string> {
  const spec = MODEL_SPECS[variant];
  const paths = getWhisperModelPaths(variant);
  const manifestFiles = loadManifestFiles(spec.manifestPath);
  const modelFiles = manifestFiles.filter((entry) => entry.path !== 'LICENSE.txt');
  const licenseFile = manifestFiles.find((entry) => entry.path === 'LICENSE.txt');

  const artifacts: WhisperArtifactSpec[] = modelFiles.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size,
    url: resolveUrl(variant, entry.path),
  }));

  const staticArtifacts: WhisperStaticArtifactSpec[] = licenseFile
    ? [{
        path: licenseFile.path,
        sha256: licenseFile.sha256,
        size: licenseFile.size,
        sourcePath: STATIC_LICENSE_PATH,
      }]
    : [];

  await ensureWhisperArtifacts({
    modelDir: paths.modelDir,
    artifacts,
    staticArtifacts,
    onProgress,
  });

  return paths.encoderModelPath;
}

const ensureWhisperModelInflight = new Map<WhisperModelVariant, Promise<string>>();
const progressListeners = new Map<WhisperModelVariant, Set<ModelDownloadProgressHandler>>();

export async function ensureWhisperModel(options: {
  variant?: WhisperModelVariant;
  onProgress?: ModelDownloadProgressHandler;
} = {}): Promise<string> {
  const variant = options.variant ?? 'base-multilingual';
  const listeners = progressListeners.get(variant) ?? new Set<ModelDownloadProgressHandler>();
  progressListeners.set(variant, listeners);
  if (options.onProgress) listeners.add(options.onProgress);
  if (!ensureWhisperModelInflight.has(variant)) {
    const pending = ensureModelInternal(variant, async (progress) => {
      await Promise.all([...listeners].map((listener) => listener(progress)));
    }).finally(() => {
      ensureWhisperModelInflight.delete(variant);
      if (listeners.size === 0) progressListeners.delete(variant);
    });
    ensureWhisperModelInflight.set(variant, pending);
  }
  try {
    return await ensureWhisperModelInflight.get(variant)!;
  } finally {
    if (options.onProgress) listeners.delete(options.onProgress);
  }
}
