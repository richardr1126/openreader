import type {
  PdfLayoutRequest,
  PdfLayoutResolution,
  PdfLayoutResult,
  WhisperAlignRequest,
  WhisperAlignResult,
  ComputeOperation,
  ComputeOperationEvent,
} from './protocol';
import { isComputeOperation } from './protocol';

class WorkerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'WorkerHttpError';
  }
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for compute worker client`);
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
  const parsed = new URL(withScheme);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/+$/, '');
}

export function getComputeWorkerConfigFromEnv(): { baseUrl: string; token: string } {
  return {
    baseUrl: normalizeWorkerBaseUrl(readRequiredEnv('COMPUTE_WORKER_URL')),
    token: readRequiredEnv('COMPUTE_WORKER_TOKEN'),
  };
}

export function isComputeWorkerAvailable(): boolean {
  try {
    getComputeWorkerConfigFromEnv();
    return true;
  } catch {
    return false;
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function alignmentWaitTimeoutMs(): number {
  return Math.max(60_000, readPositiveIntEnv('COMPUTE_WHISPER_TIMEOUT_MS', 30_000) + 15_000);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function parseSseFrame(frame: string): { id: number | null; data: string | null } {
  let id: number | null = null;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('id:')) {
      const parsed = Number(line.slice(3).trim());
      if (Number.isFinite(parsed) && parsed >= 0) id = Math.floor(parsed);
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }
  return { id, data: data.length > 0 ? data.join('\n') : null };
}

function isTerminal(operation: ComputeOperation): boolean {
  return operation.status === 'succeeded' || operation.status === 'failed';
}

export class ComputeWorkerClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config = getComputeWorkerConfigFromEnv()) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
  }

  async alignWords(input: WhisperAlignRequest): Promise<WhisperAlignResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const operation = await this.requestJson<ComputeOperation<WhisperAlignResult>>(
          'POST',
          '/v1/whisper-align/operations',
          input,
        );
        const final = isTerminal(operation)
          ? operation
          : await this.waitForOperation<WhisperAlignResult>(operation.opId, alignmentWaitTimeoutMs());
        if (final.status !== 'succeeded' || !final.result) {
          throw new Error(final.error?.message || 'Whisper worker operation did not complete');
        }
        return final.result;
      } catch (error) {
        lastError = error;
        if (attempt >= 2 || !this.shouldRetry(error)) break;
        const delay = error instanceof WorkerHttpError && error.retryAfterMs !== null
          ? error.retryAfterMs
          : attempt * 250;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Unknown compute worker failure');
  }

  createPdfLayoutOperation(input: PdfLayoutRequest): Promise<ComputeOperation<PdfLayoutResult>> {
    return this.requestJson('POST', '/v1/pdf-layout/operations', input);
  }

  resolvePdfLayout(input: PdfLayoutRequest): Promise<PdfLayoutResolution> {
    return this.requestJson('POST', '/v1/pdf-layout/resolve', {
      documentId: input.documentId,
      namespace: input.namespace,
      documentObjectKey: input.documentObjectKey,
    });
  }

  async getOperation<Result>(opId: string): Promise<ComputeOperation<Result> | null> {
    try {
      return await this.requestJson('GET', `/v1/operations/${encodeURIComponent(opId)}`);
    } catch (error) {
      if (error instanceof WorkerHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async openOperationEvents(opId: string, input?: {
    sinceEventId?: string | null;
    lastEventId?: string | null;
    signal?: AbortSignal;
  }): Promise<Response> {
    const url = new URL(`${this.baseUrl}/v1/operations/${encodeURIComponent(opId)}/events`);
    if (input?.sinceEventId) url.searchParams.set('sinceEventId', input.sinceEventId);
    return fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'text/event-stream',
        ...(input?.lastEventId ? { 'Last-Event-ID': input.lastEventId } : {}),
      },
      cache: 'no-store',
      signal: input?.signal,
    });
  }

  private async requestJson<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      cache: 'no-store',
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new WorkerHttpError(
        `Worker request failed (${method} ${path}): ${response.status}${detail ? ` ${detail}` : ''}`,
        response.status,
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
    }
    const parsed = await response.json() as T;
    return parsed;
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof WorkerHttpError) {
      return error.status === 429 || error.status === 502 || error.status === 503 || error.status === 504;
    }
    return error instanceof Error && /network|timeout|fetch failed/i.test(error.message);
  }

  private async waitForOperation<Result>(opId: string, timeoutMs: number): Promise<ComputeOperation<Result>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let lastEventId: number | null = null;
    try {
      while (!controller.signal.aborted) {
        const response = await this.openOperationEvents(opId, {
          sinceEventId: lastEventId === null ? null : String(lastEventId),
          lastEventId: lastEventId === null ? null : String(lastEventId),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new WorkerHttpError(`Worker event stream failed: ${response.status}`, response.status);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const end = buffer.indexOf('\n\n');
            if (end < 0) break;
            const frame = parseSseFrame(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            if (frame.id !== null) lastEventId = frame.id;
            if (!frame.data) continue;
            const event = JSON.parse(frame.data) as ComputeOperationEvent<Result>;
            if (!event?.snapshot || !isComputeOperation(event.snapshot) || event.snapshot.opId !== opId) continue;
            if (isTerminal(event.snapshot)) return event.snapshot;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Operation stream timed out for ${opId}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

let client: ComputeWorkerClient | null = null;

export function getComputeWorkerClient(): ComputeWorkerClient {
  client ??= new ComputeWorkerClient();
  return client;
}
