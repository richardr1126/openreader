import type { ComputeBackend, PdfLayoutInput, WhisperAlignInput, WhisperAlignResult } from '@/lib/server/compute/types';
import type {
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  WhisperAlignJobRequest,
  WhisperAlignJobResult,
  WorkerJobStatusResponse,
} from '@/lib/server/compute/worker-contract';

class WorkerHttpError extends Error {
  status: number;
  retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'WorkerHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const DEFAULT_WAIT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 2;
const POLL_INTERVAL_MS = 400;
const POLL_MAX_INTERVAL_MS = 1_500;

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when COMPUTE_MODE=worker`);
  return value;
}

function normalizeWorkerBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('COMPUTE_WORKER_URL is empty');

  const withScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : (/^(localhost|127(?:\.\d{1,3}){3})(:\d+)?(\/|$)/.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`);

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(
      `Invalid COMPUTE_WORKER_URL="${raw}". Expected full URL like https://example.com (or http://localhost:4000).`,
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/+$/, '');
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const asNum = Number(value);
  if (Number.isFinite(asNum)) {
    return Math.max(0, Math.floor(asNum * 1000));
  }
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof WorkerHttpError) {
    return error.status === 429 || error.status === 502 || error.status === 503 || error.status === 504;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('network') || msg.includes('timeout') || msg.includes('fetch failed');
  }
  return false;
}

async function withRetries<T>(attempts: number, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error)) break;
      if (error instanceof WorkerHttpError && typeof error.retryAfterMs === 'number') {
        await sleep(error.retryAfterMs);
      } else {
        await sleep((attempt + 1) * 250);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unknown worker compute failure');
}

export class WorkerComputeBackend implements ComputeBackend {
  readonly mode = 'worker' as const;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly waitTimeoutMs: number;
  private readonly retries: number;

  constructor() {
    this.baseUrl = normalizeWorkerBaseUrl(readRequiredEnv('COMPUTE_WORKER_URL'));
    this.token = readRequiredEnv('COMPUTE_WORKER_TOKEN');
    this.waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
    this.retries = DEFAULT_RETRIES;
  }

  async alignWords(input: WhisperAlignInput): Promise<WhisperAlignResult> {
    if (!input.audioObjectKey) {
      throw new Error('Worker compute alignment requires audioObjectKey');
    }
    const payload: WhisperAlignJobRequest = {
      text: input.text,
      lang: input.lang,
      cacheKey: input.cacheKey,
      audioObjectKey: input.audioObjectKey,
    };

    return withRetries(this.retries, async () => {
      const { jobId } = await this.requestJson<{ jobId: string }>('POST', '/align/whisper/jobs', payload);
      const status = await this.waitForJob<WhisperAlignJobResult>(`/align/whisper/jobs/${encodeURIComponent(jobId)}`);
      if (status.status !== 'succeeded' || !status.result) {
        throw new Error(status.error?.message || 'Whisper worker job did not complete');
      }
      return { alignments: status.result.alignments };
    });
  }

  async parsePdfLayout(input: PdfLayoutInput) {
    if (!input.documentObjectKey) {
      throw new Error('Worker compute PDF layout requires documentObjectKey');
    }
    const payload: PdfLayoutJobRequest = {
      documentId: input.documentId,
      namespace: input.namespace ?? null,
      documentObjectKey: input.documentObjectKey,
    };
    return withRetries(this.retries, async () => {
      const { jobId } = await this.requestJson<{ jobId: string }>('POST', '/layout/pdf/jobs', payload);
      const status = await this.waitForJob<PdfLayoutJobResult>(`/layout/pdf/jobs/${encodeURIComponent(jobId)}`);
      if (status.status !== 'succeeded' || !status.result) {
        throw new Error(status.error?.message || 'PDF layout worker job did not complete');
      }
      if (status.result.parsedObjectKey) {
        return { parsedObjectKey: status.result.parsedObjectKey };
      }
      if (status.result.parsed) {
        return { parsed: status.result.parsed };
      }
      throw new Error('PDF layout worker job completed without parsed output');
    });
  }

  private async requestJson<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });

    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const detail = await res.text().catch(() => '');
      throw new WorkerHttpError(
        `Worker request failed (${method} ${path}): ${res.status}${detail ? ` ${detail}` : ''}`,
        res.status,
        retryAfterMs,
      );
    }

    return res.json() as Promise<T>;
  }

  private async waitForJob<Result>(path: string): Promise<WorkerJobStatusResponse<Result>> {
    const started = Date.now();
    let interval = POLL_INTERVAL_MS;
    while ((Date.now() - started) < this.waitTimeoutMs) {
      const status = await this.requestJson<WorkerJobStatusResponse<Result>>('GET', path);
      if (status.status === 'succeeded' || status.status === 'failed') return status;
      await sleep(interval);
      interval = Math.min(POLL_MAX_INTERVAL_MS, Math.floor(interval * 1.5));
    }
    throw new Error(`Timed out waiting for worker job after ${this.waitTimeoutMs}ms`);
  }
}
