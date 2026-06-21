import type { FastifyInstance, FastifyRequest } from 'fastify';

const REQUEST_STARTED_AT_MS_KEY = Symbol('request-started-at-ms');
const REQUEST_COUNTED_KEY = Symbol('request-activity-counted');

function requestPath(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? request.url;
}

function isHealthPath(path: string): boolean {
  return path === '/health/live' || path === '/health/ready';
}

function isPublicPlaybackPath(path: string): boolean {
  return /^\/v1\/tts-playback\/[^/]+\/audio$/.test(path);
}

function isAuthed(request: FastifyRequest, expectedToken: string): boolean {
  const auth = request.headers.authorization;
  return auth?.startsWith('Bearer ') === true
    && auth.slice('Bearer '.length).trim() === expectedToken;
}

function extractTraceId(request: FastifyRequest): string | null {
  const header = request.headers['x-openreader-trace-id'];
  if (Array.isArray(header)) return header[0] ?? null;
  return typeof header === 'string' ? header : null;
}

function extractOpId(request: FastifyRequest, path: string): string | null {
  const params = request.params as { opId?: unknown } | undefined;
  if (typeof params?.opId === 'string' && params.opId.trim()) return params.opId.trim();
  const match = path.match(/^\/v1\/operations\/([^/]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function registerHttpHooks(input: {
  app: FastifyInstance;
  workerToken: string;
  markActivity: (reason: string) => void;
  onInFlightHttpChanged: (delta: number) => void;
}) {
  const releaseHttp = (request: FastifyRequest): void => {
    const counted = request as FastifyRequest & { [REQUEST_COUNTED_KEY]?: boolean };
    if (!counted[REQUEST_COUNTED_KEY]) return;
    counted[REQUEST_COUNTED_KEY] = false;
    input.onInFlightHttpChanged(-1);
    input.markActivity('http_completed');
  };

  input.app.addHook('onRequest', async (request, reply) => {
    const path = requestPath(request);
    (request as FastifyRequest & { [REQUEST_STARTED_AT_MS_KEY]?: number })[REQUEST_STARTED_AT_MS_KEY] = Date.now();
    (request as FastifyRequest & { [REQUEST_COUNTED_KEY]?: boolean })[REQUEST_COUNTED_KEY] = true;
    input.onInFlightHttpChanged(1);
    input.markActivity(`http_started:${path}`);
    if (!isHealthPath(path) && !isPublicPlaybackPath(path) && !isAuthed(request, input.workerToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  input.app.addHook('onResponse', async (request, reply) => {
    releaseHttp(request);
    const path = requestPath(request);
    if (isHealthPath(path) || reply.statusCode < 500) return;
    const startedAt = (request as FastifyRequest & { [REQUEST_STARTED_AT_MS_KEY]?: number })[REQUEST_STARTED_AT_MS_KEY];
    input.app.log.error({
      reqId: request.id,
      method: request.method,
      path,
      statusCode: reply.statusCode,
      durationMs: Number.isFinite(startedAt) ? Math.max(0, Date.now() - (startedAt as number)) : -1,
      traceId: extractTraceId(request),
      opId: extractOpId(request, path),
    }, 'http.error');
  });

  return { releaseHttp };
}
