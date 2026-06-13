import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { DOCSTORE_DIR } from '../../infrastructure/platform';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = path.join(DOCSTORE_DIR, 'model', 'whisper-base_timestamped');
const STATIC_LICENSE_PATH = path.join(MODULE_DIR, 'assets', 'LICENSE.txt');
const MANIFEST_PATH = path.join(MODULE_DIR, 'assets', 'manifest.json');

export const WHISPER_CONFIG_PATH = path.join(MODEL_DIR, 'config.json');
export const WHISPER_GENERATION_CONFIG_PATH = path.join(MODEL_DIR, 'generation_config.json');
export const WHISPER_TOKENIZER_PATH = path.join(MODEL_DIR, 'tokenizer.json');
export const WHISPER_TOKENIZER_CONFIG_PATH = path.join(MODEL_DIR, 'tokenizer_config.json');
export const WHISPER_ENCODER_MODEL_PATH = path.join(MODEL_DIR, 'onnx', 'encoder_model_q4.onnx');
export const WHISPER_DECODER_MERGED_MODEL_PATH = path.join(MODEL_DIR, 'onnx', 'decoder_model_merged_q4.onnx');
export const WHISPER_DECODER_WITH_PAST_MODEL_PATH = path.join(MODEL_DIR, 'onnx', 'decoder_with_past_model_q4.onnx');

const BASE_MODEL_URL = 'https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/main';
const WHISPER_MODEL_BASE_URL_ENV = 'WHISPER_MODEL_BASE_URL';

const MODEL_RELATIVE_PATHS: string[] = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'merges.txt',
  'vocab.json',
  'normalizer.json',
  'added_tokens.json',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'onnx/encoder_model_q4.onnx',
  'onnx/decoder_model_merged_q4.onnx',
  'onnx/decoder_with_past_model_q4.onnx',
];

const DEFAULT_URLS: Record<string, string> = {
  'config.json': `${BASE_MODEL_URL}/config.json`,
  'generation_config.json': `${BASE_MODEL_URL}/generation_config.json`,
  'tokenizer.json': `${BASE_MODEL_URL}/tokenizer.json`,
  'tokenizer_config.json': `${BASE_MODEL_URL}/tokenizer_config.json`,
  'merges.txt': `${BASE_MODEL_URL}/merges.txt`,
  'vocab.json': `${BASE_MODEL_URL}/vocab.json`,
  'normalizer.json': `${BASE_MODEL_URL}/normalizer.json`,
  'added_tokens.json': `${BASE_MODEL_URL}/added_tokens.json`,
  'preprocessor_config.json': `${BASE_MODEL_URL}/preprocessor_config.json`,
  'special_tokens_map.json': `${BASE_MODEL_URL}/special_tokens_map.json`,
  'onnx/encoder_model_q4.onnx': `${BASE_MODEL_URL}/onnx/encoder_model_q4.onnx`,
  'onnx/decoder_model_merged_q4.onnx': `${BASE_MODEL_URL}/onnx/decoder_model_merged_q4.onnx`,
  'onnx/decoder_with_past_model_q4.onnx': `${BASE_MODEL_URL}/onnx/decoder_with_past_model_q4.onnx`,
};

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

function loadManifestFiles(): ManifestEntry[] {
  const manifestText = readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(manifestText) as { files?: ManifestEntry[] };
  return Array.isArray(parsed.files) ? parsed.files : [];
}

const MANIFEST_FILES = loadManifestFiles();
const MODEL_FILES = MANIFEST_FILES.filter((entry) => entry.path !== 'LICENSE.txt');
const LICENSE_FILE = MANIFEST_FILES.find((entry) => entry.path === 'LICENSE.txt');

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

function resolveUrl(relativePath: string): string {
  const overrideBase = process.env[WHISPER_MODEL_BASE_URL_ENV]?.trim();
  if (overrideBase) {
    return joinModelUrl(overrideBase, relativePath);
  }
  const fallback = DEFAULT_URLS[relativePath];
  if (!fallback) {
    throw new Error(`No default URL configured for Whisper model artifact: ${relativePath}`);
  }
  return fallback;
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

async function downloadToFile(fetchImpl: WhisperFetch, url: string, outPath: string): Promise<void> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Download failed for ${url}: ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(outPath, bytes);
}

export async function ensureWhisperArtifacts(options: {
  modelDir: string;
  artifacts: WhisperArtifactSpec[];
  staticArtifacts?: WhisperStaticArtifactSpec[];
  fetchImpl?: WhisperFetch;
}): Promise<void> {
  const {
    modelDir,
    artifacts,
    staticArtifacts = [],
    fetchImpl = fetch,
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

  for (const artifact of artifacts) {
    const target = resolvePath(artifact.path, modelDir);
    const targetDir = path.dirname(target);
    const tmp = `${target}.tmp`;

    await mkdir(targetDir, { recursive: true });
    await downloadToFile(fetchImpl, artifact.url, tmp);
    if (!(await verifyFile(tmp, artifact))) {
      await unlink(tmp).catch(() => undefined);
      throw new Error(`Whisper artifact checksum verification failed: ${artifact.path}`);
    }
    await rename(tmp, target);
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

export function createSingleflightRunner<T>(work: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return async () => {
    if (inflight) return inflight;
    inflight = work().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

async function ensureModelInternal(): Promise<string> {
  if (process.env[WHISPER_MODEL_BASE_URL_ENV]?.trim()) {
    for (const relativePath of MODEL_RELATIVE_PATHS) {
      if (!(relativePath in DEFAULT_URLS)) {
        throw new Error(`Missing default URL path mapping for Whisper artifact: ${relativePath}`);
      }
    }
  }

  const artifacts: WhisperArtifactSpec[] = MODEL_FILES.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size,
    url: resolveUrl(entry.path),
  }));

  const staticArtifacts: WhisperStaticArtifactSpec[] = LICENSE_FILE
    ? [{
        path: LICENSE_FILE.path,
        sha256: LICENSE_FILE.sha256,
        size: LICENSE_FILE.size,
        sourcePath: STATIC_LICENSE_PATH,
      }]
    : [];

  await ensureWhisperArtifacts({
    modelDir: MODEL_DIR,
    artifacts,
    staticArtifacts,
  });

  return WHISPER_ENCODER_MODEL_PATH;
}

const ensureWhisperModelSingleflight = createSingleflightRunner(ensureModelInternal);

export async function ensureWhisperModel(): Promise<string> {
  return ensureWhisperModelSingleflight();
}
