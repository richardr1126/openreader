import { createHash, randomUUID } from 'node:crypto';
import type { ComputeBackend, PdfLayoutInput, WhisperAlignInput, WhisperAlignResult } from '@/lib/server/compute/types';
import { getWorkerClientWaitTimeoutMs } from '@openreader/compute-core/runtime';
import type {
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  WhisperAlignJobRequest,
  WhisperAlignJobResult,
  WorkerOperationState,
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

const DEFAULT_RETRIES = 2;
const LOG_PREFIX = '[compute-worker-client]';
const MAX_LOG_DETAIL_CHARS = 600;
const LOG_EVENTS = new Set([
  'align.request.failed',
  'align.request.attempt_error',
  'pdf_layout.request.failed',
  'pdf_layout.request.attempt_error',
  'http.request.failed',
  'sse.wait.http_failed',
  'sse.wait.ended_without_terminal',
  'sse.wait.failed',
]);

type WorkerLogLevel = 'info' | 'warn' | 'error';

function truncateForLog(value: string, maxChars = MAX_LOG_DETAIL_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

function errorToLog(error: unknown): Record<string, unknown> {
  if (error instanceof WorkerHttpError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function logWorker(level: WorkerLogLevel, event: string, fields: Record<string, unknown>): void {
  if (!LOG_EVENTS.has(event)) return;

  const payload = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  const line = `${LOG_PREFIX} ${JSON.stringify(payload)}`;
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.info(line);
}

function opSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if (typeof record.opId === 'string') summary.opId = record.opId;
  if (typeof record.status === 'string') summary.status = record.status;
  if (typeof record.jobId === 'string') summary.jobId = record.jobId;
  if (typeof record.updatedAt === 'string') summary.updatedAt = record.updatedAt;
  return summary;
}

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

function isTerminalStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed';
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function buildWhisperOpKey(input: WhisperAlignInput): string {
  const cacheKey = input.cacheKey?.trim();
  if (cacheKey) {
    return `whisper_align|v1|cache|${cacheKey}|${input.audioObjectKey}`;
  }
  return [
    'whisper_align',
    'v1',
    input.audioObjectKey,
    input.lang ?? '',
    sha256Hex(input.text),
  ].join('|');
}

export function buildPdfOpKey(input: PdfLayoutInput): string {
  return [
    'pdf_layout',
    'v1',
    input.documentId,
    input.namespace ?? '',
    input.documentObjectKey ?? '',
    input.forceToken?.trim() || '',
  ].join('|');
}

function extractSsePayload(frame: string): string | null {
  const dataLines: string[] = [];
  const normalized = frame.replace(/\r\n/g, '\n');
  for (const line of normalized.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

type RetryMeta = {
  attempt: number,
  maxAttempts: number,
  willRetry: boolean,
  delayMs: number | null,
  error: unknown,
};

async function withRetries<T>(
  attempts: number,
  operation: (attempt: number) => Promise<T>,
  onAttemptError?: (meta: RetryMeta) => void,
): Promise<T> {
  let lastError: unknown = null;
  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
    const attempt = attemptIndex + 1;
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const willRetry = attemptIndex < attempts - 1 && shouldRetry(error);
      let delayMs: number | null = null;
      if (willRetry) {
        if (error instanceof WorkerHttpError && typeof error.retryAfterMs === 'number') {
          delayMs = error.retryAfterMs;
        } else {
          delayMs = attempt * 250;
        }
      }
      onAttemptError?.({
        attempt,
        maxAttempts: attempts,
        willRetry,
        delayMs,
        error,
      });
      if (!willRetry) break;
      await sleep(delayMs ?? 0);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unknown worker compute failure');
}

export class WorkerComputeBackend implements ComputeBackend {
  readonly mode = 'worker' as const;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly waitTimeoutMsByKind: Record<'whisper_align' | 'pdf_layout', number>;
  private readonly retries: number;

  constructor() {
    this.baseUrl = normalizeWorkerBaseUrl(readRequiredEnv('COMPUTE_WORKER_URL'));
    this.token = readRequiredEnv('COMPUTE_WORKER_TOKEN');
    this.waitTimeoutMsByKind = {
      whisper_align: getWorkerClientWaitTimeoutMs('whisper_align'),
      pdf_layout: getWorkerClientWaitTimeoutMs('pdf_layout'),
    };
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
    const traceId = randomUUID();
    const opKey = buildWhisperOpKey(input);
    const opKeyHash = sha256Hex(opKey).slice(0, 16);
    const startedAt = Date.now();
    logWorker('info', 'align.request.start', {
      traceId,
      kind: 'whisper_align',
      opKeyHash,
      audioObjectKey: input.audioObjectKey,
      cacheKey: input.cacheKey ?? null,
      lang: input.lang ?? null,
      textLength: input.text.length,
      waitTimeoutMs: this.waitTimeoutMsByKind.whisper_align,
      maxRetries: this.retries,
    });

    try {
      const result = await withRetries(this.retries, async (attempt) => {
        const op = await this.requestJson<WorkerOperationState<WhisperAlignJobResult>>('POST', '/ops', {
          kind: 'whisper_align',
          opKey,
          payload,
        }, {
          traceId,
          kind: 'whisper_align',
          opKeyHash,
          attempt,
        });

        const final = isTerminalStatus(op.status)
          ? op
          : await this.waitForOperation<WhisperAlignJobResult>(op.opId, {
            traceId,
            kind: 'whisper_align',
            opKeyHash,
            attempt,
            waitTimeoutMs: this.waitTimeoutMsByKind.whisper_align,
          });

        if (final.status !== 'succeeded' || !final.result) {
          throw new Error(final.error?.message || 'Whisper worker operation did not complete');
        }
        return { alignments: final.result.alignments };
      }, ({ attempt, maxAttempts, willRetry, delayMs, error }) => {
        logWorker(willRetry ? 'warn' : 'error', 'align.request.attempt_error', {
          traceId,
          kind: 'whisper_align',
          opKeyHash,
          attempt,
          maxAttempts,
          willRetry,
          delayMs,
          error: errorToLog(error),
        });
      });

      logWorker('info', 'align.request.succeeded', {
        traceId,
        kind: 'whisper_align',
        opKeyHash,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      logWorker('error', 'align.request.failed', {
        traceId,
        kind: 'whisper_align',
        opKeyHash,
        durationMs: Date.now() - startedAt,
        error: errorToLog(error),
      });
      throw error;
    }
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
    const traceId = randomUUID();
    const opKey = buildPdfOpKey(input);
    const opKeyHash = sha256Hex(opKey).slice(0, 16);
    const startedAt = Date.now();
    logWorker('info', 'pdf_layout.request.start', {
      traceId,
      kind: 'pdf_layout',
      opKeyHash,
      documentId: input.documentId,
      namespace: input.namespace ?? null,
      documentObjectKey: input.documentObjectKey,
      waitTimeoutMs: this.waitTimeoutMsByKind.pdf_layout,
      maxRetries: this.retries,
    });

    try {
      const result = await withRetries(this.retries, async (attempt) => {
        const op = await this.requestJson<WorkerOperationState<PdfLayoutJobResult>>('POST', '/ops', {
          kind: 'pdf_layout',
          opKey,
          payload,
        }, {
          traceId,
          kind: 'pdf_layout',
          opKeyHash,
          documentId: input.documentId,
          attempt,
        });

        const final = isTerminalStatus(op.status)
          ? op
          : await this.waitForOperation<PdfLayoutJobResult>(op.opId, {
            traceId,
            kind: 'pdf_layout',
            opKeyHash,
            documentId: input.documentId,
            attempt,
            waitTimeoutMs: this.waitTimeoutMsByKind.pdf_layout,
            onSnapshot: (snapshot) => {
              if (snapshot.progress) {
                void input.onProgress?.(snapshot.progress);
              }
            },
          });

        if (final.status !== 'succeeded' || !final.result) {
          throw new Error(final.error?.message || 'PDF layout worker operation did not complete');
        }
        if (final.result.parsedObjectKey) {
          return { parsedObjectKey: final.result.parsedObjectKey };
        }
        if (final.result.parsed) {
          return { parsed: final.result.parsed };
        }
        throw new Error('PDF layout worker operation completed without parsed output');
      }, ({ attempt, maxAttempts, willRetry, delayMs, error }) => {
        logWorker(willRetry ? 'warn' : 'error', 'pdf_layout.request.attempt_error', {
          traceId,
          kind: 'pdf_layout',
          opKeyHash,
          documentId: input.documentId,
          attempt,
          maxAttempts,
          willRetry,
          delayMs,
          error: errorToLog(error),
        });
      });

      logWorker('info', 'pdf_layout.request.succeeded', {
        traceId,
        kind: 'pdf_layout',
        opKeyHash,
        documentId: input.documentId,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      logWorker('error', 'pdf_layout.request.failed', {
        traceId,
        kind: 'pdf_layout',
        opKeyHash,
        documentId: input.documentId,
        durationMs: Date.now() - startedAt,
        error: errorToLog(error),
      });
      throw error;
    }
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    context: Record<string, unknown> = {},
  ): Promise<T> {
    const startedAt = Date.now();
    const traceId = typeof context.traceId === 'string' ? context.traceId : randomUUID();
    logWorker('info', 'http.request.start', {
      ...context,
      traceId,
      method,
      path,
    });
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'x-openreader-trace-id': traceId,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });

    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const detail = await res.text().catch(() => '');
      logWorker(res.status >= 500 ? 'warn' : 'error', 'http.request.failed', {
        ...context,
        traceId,
        method,
        path,
        status: res.status,
        retryAfterMs,
        durationMs: Date.now() - startedAt,
        detail: truncateForLog(detail),
      });
      throw new WorkerHttpError(
        `Worker request failed (${method} ${path}): ${res.status}${detail ? ` ${detail}` : ''}`,
        res.status,
        retryAfterMs,
      );
    }

    const parsed = await res.json() as T;
    const operationSummary = opSummary(parsed);
    logWorker('info', 'http.request.succeeded', {
      ...context,
      traceId,
      method,
      path,
      httpStatus: res.status,
      durationMs: Date.now() - startedAt,
      ...operationSummary,
    });
    return parsed;
  }

  private async waitForOperation<Result>(
    opId: string,
    context: Record<string, unknown> & {
      waitTimeoutMs?: number;
      onSnapshot?: (snapshot: WorkerOperationState<Result>) => void
    } = {},
  ): Promise<WorkerOperationState<Result>> {
    const waitTimeoutMs = typeof context.waitTimeoutMs === 'number'
      ? context.waitTimeoutMs
      : this.waitTimeoutMsByKind.whisper_align;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), waitTimeoutMs);
    const startedAt = Date.now();
    const traceId = typeof context.traceId === 'string' ? context.traceId : randomUUID();
    logWorker('info', 'sse.wait.start', {
      ...context,
      traceId,
      opId,
      waitTimeoutMs,
    });

    try {
      const res = await fetch(`${this.baseUrl}/ops/${encodeURIComponent(opId)}/events`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'text/event-stream',
          'x-openreader-trace-id': traceId,
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
        const detail = await res.text().catch(() => '');
        logWorker(res.status >= 500 ? 'warn' : 'error', 'sse.wait.http_failed', {
          ...context,
          traceId,
          opId,
          status: res.status,
          retryAfterMs,
          durationMs: Date.now() - startedAt,
          detail: truncateForLog(detail),
        });
        throw new WorkerHttpError(
          `Worker request failed (GET /ops/${encodeURIComponent(opId)}/events): ${res.status}${detail ? ` ${detail}` : ''}`,
          res.status,
          retryAfterMs,
        );
      }

      if (!res.body) {
        logWorker('error', 'sse.wait.no_body', {
          ...context,
          traceId,
          opId,
          durationMs: Date.now() - startedAt,
        });
        throw new Error('Worker operation stream response has no body');
      }

      logWorker('info', 'sse.wait.connected', {
        ...context,
        traceId,
        opId,
        status: res.status,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let latest: WorkerOperationState<Result> | null = null;
      let eventCount = 0;
      let lastStatus: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const frameEnd = buffer.indexOf('\n\n');
          if (frameEnd < 0) break;
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);

          const payload = extractSsePayload(frame);
          if (!payload) continue;

          let snapshot: WorkerOperationState<Result>;
          try {
            snapshot = JSON.parse(payload) as WorkerOperationState<Result>;
          } catch {
            logWorker('warn', 'sse.wait.json_parse_skipped', {
              ...context,
              traceId,
              opId,
              sample: truncateForLog(payload),
            });
            continue;
          }

          eventCount += 1;
          latest = snapshot;
          context.onSnapshot?.(snapshot);
          if (snapshot.status !== lastStatus) {
            lastStatus = snapshot.status;
            logWorker('info', 'sse.wait.status', {
              ...context,
              traceId,
              opId,
              eventCount,
              status: snapshot.status,
              jobId: snapshot.jobId ?? null,
              updatedAt: snapshot.updatedAt ?? null,
            });
          }
          if (isTerminalStatus(snapshot.status)) {
            logWorker('info', 'sse.wait.terminal', {
              ...context,
              traceId,
              opId,
              eventCount,
              status: snapshot.status,
              durationMs: Date.now() - startedAt,
            });
            return snapshot;
          }
        }
      }

      if (latest && isTerminalStatus(latest.status)) {
        logWorker('info', 'sse.wait.terminal_after_close', {
          ...context,
          traceId,
          opId,
          eventCount,
          status: latest.status,
          durationMs: Date.now() - startedAt,
        });
        return latest;
      }

      logWorker('error', 'sse.wait.ended_without_terminal', {
        ...context,
        traceId,
        opId,
        eventCount,
        latestStatus: latest?.status ?? null,
        durationMs: Date.now() - startedAt,
      });
      throw new Error(`Operation stream ended before terminal state for op ${opId}`);
    } catch (error) {
      logWorker('error', 'sse.wait.failed', {
        ...context,
        traceId,
        opId,
        durationMs: Date.now() - startedAt,
        error: errorToLog(error),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
