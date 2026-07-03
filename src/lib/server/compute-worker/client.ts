import type {
  PdfLayoutRequest,
  PdfLayoutResolution,
  PdfLayoutResult,
  DocumentPreviewRequest,
  DocumentPreviewResolution,
  TtsPlaybackRequest,
  TtsPlaybackExportArtifactRequest,
  TtsPlaybackExportArtifactResolution,
  TtsPlaybackPlanRequest,
  TtsPlaybackSessionState,
  TtsPlaybackCompletedSegment,
  TtsPlaybackResetResult,
  TtsPlaybackSessionResolution,
  TtsPlaybackSessionResolveRequest,
  ComputeOperation,
} from './protocol';

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

export function getComputeWorkerPublicBaseUrl(): string {
  const publicUrl = process.env.COMPUTE_WORKER_PUBLIC_URL?.trim();
  return normalizeWorkerBaseUrl(publicUrl || readRequiredEnv('COMPUTE_WORKER_URL'));
}

export function isComputeWorkerAvailable(): boolean {
  try {
    getComputeWorkerConfigFromEnv();
    return true;
  } catch {
    return false;
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export class ComputeWorkerClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config = getComputeWorkerConfigFromEnv()) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
  }

  createPdfLayoutOperation(input: PdfLayoutRequest): Promise<ComputeOperation<PdfLayoutResult>> {
    return this.requestJson('POST', '/v1/pdf-layout/jobs', input);
  }

  createDocumentPreviewOperation(input: DocumentPreviewRequest): Promise<ComputeOperation> {
    return this.requestJson('POST', '/v1/document-previews/jobs', input);
  }

  resolvePdfLayout(input: PdfLayoutRequest): Promise<PdfLayoutResolution> {
    return this.requestJson('POST', '/v1/pdf-layout/resolve', {
      documentId: input.documentId,
      namespace: input.namespace,
      documentObjectKey: input.documentObjectKey,
    });
  }

  resolveDocumentPreview(input: Omit<DocumentPreviewRequest, 'targetWidth'>): Promise<DocumentPreviewResolution> {
    return this.requestJson('POST', '/v1/document-previews/resolve', input);
  }

  createTtsPlaybackOperation(input: TtsPlaybackRequest): Promise<ComputeOperation> {
    return this.requestJson('POST', '/v1/tts-playback/sessions/jobs', input);
  }

  createTtsPlaybackPlanOperation(input: TtsPlaybackPlanRequest): Promise<ComputeOperation> {
    return this.requestJson('POST', '/v1/tts-playback/plans/jobs', input);
  }

  createTtsPlaybackExportArtifactOperation(input: TtsPlaybackExportArtifactRequest): Promise<ComputeOperation> {
    return this.requestJson('POST', '/v1/tts-playback/exports/jobs', input);
  }

  resolveTtsPlaybackSession(input: TtsPlaybackSessionResolveRequest): Promise<TtsPlaybackSessionResolution> {
    return this.requestJson('POST', '/v1/tts-playback/sessions/resolve', input);
  }

  resolveTtsPlaybackExportArtifact(input: {
    artifactId: string;
    documentId: string;
    documentVersion: number;
    settingsHash: string;
    format: 'mp3' | 'm4b';
    speed: number;
  }): Promise<TtsPlaybackExportArtifactResolution> {
    return this.requestJson('POST', '/v1/tts-playback/exports/resolve', input);
  }

  async getTtsPlaybackSession(sessionId: string): Promise<TtsPlaybackSessionState | null> {
    try {
      return await this.requestJson('GET', `/v1/tts-playback/sessions/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      if (error instanceof WorkerHttpError && error.status === 404) return null;
      throw error;
    }
  }

  listTtsPlaybackSegments(input: {
    sessionId: string;
    minOrdinal?: number;
    limit?: number;
  }): Promise<{ sessionId: string; segments: TtsPlaybackCompletedSegment[] }> {
    const search = new URLSearchParams();
    if (input.minOrdinal !== undefined) search.set('minOrdinal', String(input.minOrdinal));
    if (input.limit !== undefined) search.set('limit', String(input.limit));
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return this.requestJson('GET', `/v1/tts-playback/sessions/${encodeURIComponent(input.sessionId)}/segments${suffix}`);
  }

  updateTtsPlaybackCursor(input: {
    sessionId: string;
    ordinal: number;
    expiresAt?: number;
  }): Promise<{ sessionId: string; cursorOrdinal: number; expiresAt: number }> {
    return this.requestJson('PUT', `/v1/tts-playback/sessions/${encodeURIComponent(input.sessionId)}/cursor`, {
      ordinal: input.ordinal,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
  }

  resetTtsPlaybackScope(input: {
    storageUserId: string;
    documentId: string;
    documentVersion?: number;
    settingsHash?: string;
  }): Promise<TtsPlaybackResetResult> {
    return this.requestJson('POST', '/v1/tts-playback/cache/reset', input);
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

  private async requestJson<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(method === 'POST' || method === 'PUT' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' || method === 'PUT' ? { body: JSON.stringify(body ?? {}) } : {}),
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
}

let client: ComputeWorkerClient | null = null;

export function getComputeWorkerClient(): ComputeWorkerClient {
  client ??= new ComputeWorkerClient();
  return client;
}
