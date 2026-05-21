const DEFAULT_COMPUTE_WHISPER_TIMEOUT_MS = 30_000;
const DEFAULT_COMPUTE_PDF_TIMEOUT_MS = 300_000;
const DEFAULT_COMPUTE_PDF_HARD_CAP_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WORKER_WAIT_BUFFER_MS = 15_000;
const DEFAULT_WORKER_WAIT_MIN_MS = 60_000;

export type ComputeTimeoutConfig = {
  whisperTimeoutMs: number;
  pdfTimeoutMs: number;
  pdfHardCapMs: number;
};

export type ComputeOperationKind = 'whisper_align' | 'pdf_layout';

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

let timeoutConfigCache: ComputeTimeoutConfig | null = null;

export function getComputeTimeoutConfig(): ComputeTimeoutConfig {
  if (timeoutConfigCache) return timeoutConfigCache;
  timeoutConfigCache = {
    whisperTimeoutMs: readPositiveIntEnv('COMPUTE_WHISPER_TIMEOUT_MS', DEFAULT_COMPUTE_WHISPER_TIMEOUT_MS),
    pdfTimeoutMs: readPositiveIntEnv('COMPUTE_PDF_TIMEOUT_MS', DEFAULT_COMPUTE_PDF_TIMEOUT_MS),
    pdfHardCapMs: DEFAULT_COMPUTE_PDF_HARD_CAP_MS,
  };
  return timeoutConfigCache;
}

export function getWorkerClientWaitTimeoutMs(kind: ComputeOperationKind): number {
  const config = getComputeTimeoutConfig();
  const timeoutMs = kind === 'pdf_layout' ? config.pdfTimeoutMs : config.whisperTimeoutMs;
  return Math.max(DEFAULT_WORKER_WAIT_MIN_MS, timeoutMs + DEFAULT_WORKER_WAIT_BUFFER_MS);
}
