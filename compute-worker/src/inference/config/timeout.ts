const DEFAULT_COMPUTE_WHISPER_TIMEOUT_MS = 30_000;
const DEFAULT_COMPUTE_PDF_TIMEOUT_MS = 300_000;
const DEFAULT_COMPUTE_PDF_HARD_CAP_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COMPUTE_OP_STALE_MIN_MS = 30 * 60_000;
const DEFAULT_WORKER_WAIT_BUFFER_MS = 15_000;
const DEFAULT_WORKER_WAIT_MIN_MS = 60_000;

export type ComputeTimeoutConfig = {
  whisperTimeoutMs: number;
  pdfTimeoutMs: number;
  pdfHardCapMs: number;
};

export type ComputeOperationKind = 'whisper_align' | 'pdf_layout';
export type IdleTimeoutAndHardCapInput<T> = {
  run: (touchProgress: () => void) => Promise<T>;
  idleTimeoutMs: number;
  hardCapMs: number;
  label: string;
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

let timeoutConfigCache: ComputeTimeoutConfig | null = null;
let opStaleMsCache: number | null = null;

export function getComputeTimeoutConfig(): ComputeTimeoutConfig {
  if (timeoutConfigCache) return timeoutConfigCache;
  timeoutConfigCache = {
    whisperTimeoutMs: readPositiveIntEnv('COMPUTE_WHISPER_TIMEOUT_MS', DEFAULT_COMPUTE_WHISPER_TIMEOUT_MS),
    pdfTimeoutMs: readPositiveIntEnv('COMPUTE_PDF_TIMEOUT_MS', DEFAULT_COMPUTE_PDF_TIMEOUT_MS),
    pdfHardCapMs: DEFAULT_COMPUTE_PDF_HARD_CAP_MS,
  };
  return timeoutConfigCache;
}

export function getComputeOpStaleMs(): number {
  if (typeof opStaleMsCache === 'number') return opStaleMsCache;
  const config = getComputeTimeoutConfig();
  opStaleMsCache = readPositiveIntEnv(
    'COMPUTE_OP_STALE_MS',
    Math.max(DEFAULT_COMPUTE_OP_STALE_MIN_MS, Math.max(config.whisperTimeoutMs, config.pdfTimeoutMs) * 4),
  );
  return opStaleMsCache;
}

export function getWorkerClientWaitTimeoutMs(kind: ComputeOperationKind): number {
  const config = getComputeTimeoutConfig();
  const timeoutMs = kind === 'pdf_layout' ? config.pdfTimeoutMs : config.whisperTimeoutMs;
  return Math.max(DEFAULT_WORKER_WAIT_MIN_MS, timeoutMs + DEFAULT_WORKER_WAIT_BUFFER_MS);
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withIdleTimeoutAndHardCap<T>(input: IdleTimeoutAndHardCapInput<T>): Promise<T> {
  let idleTimer: NodeJS.Timeout | null = null;
  let hardCapTimer: NodeJS.Timeout | null = null;
  let settled = false;
  let rejectTimeout!: (reason: unknown) => void;

  const clearTimers = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (hardCapTimer) {
      clearTimeout(hardCapTimer);
      hardCapTimer = null;
    }
  };

  const failTimeout = (kind: 'idle' | 'hard cap', timeoutMs: number) => {
    if (settled) return;
    settled = true;
    clearTimers();
    rejectTimeout(new Error(`${input.label} ${kind} timed out after ${timeoutMs}ms`));
  };

  const touchProgress = () => {
    if (settled) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => failTimeout('idle', input.idleTimeoutMs), input.idleTimeoutMs);
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    hardCapTimer = setTimeout(() => failTimeout('hard cap', input.hardCapMs), input.hardCapMs);
    touchProgress();
  });

  try {
    const result = await Promise.race([input.run(touchProgress), timeoutPromise]);
    settled = true;
    clearTimers();
    return result as T;
  } catch (error) {
    settled = true;
    clearTimers();
    throw error;
  }
}
