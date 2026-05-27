import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  connect,
  nanos,
  credsAuthenticator,
  type NatsConnection,
} from '@nats-io/transport-node';
import {
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type Consumer,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
} from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import {
  ensureComputeModels,
  runPdfLayoutFromPdfBuffer,
  runWhisperAlignmentFromAudioBuffer,
} from '@openreader/compute-core/local-runtime';
import {
  getComputeTimeoutConfig,
  getComputeOpStaleMs,
  getAvailableCpuCores,
  getOnnxThreadsPerJob,
  withIdleTimeoutAndHardCap,
  withTimeout,
} from '@openreader/compute-core';
import { encodeSseFrame, OperationOrchestrator } from '@openreader/compute-core/control-plane';
import type {
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  WorkerOperationEvent,
  WhisperAlignJobRequest,
  WhisperAlignJobResult,
  WorkerJobState,
  WorkerJobTiming,
  WorkerOperationKind,
  WorkerOperationRequest,
  WorkerOperationState,
  PdfLayoutProgress,
} from '@openreader/compute-core/api-contracts';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  JetStreamOperationEventStream,
  JetStreamOperationQueue,
  JetStreamOperationStateStore,
  hashOpKey,
} from './control-plane/jetstream';

const JOBS_STREAM_NAME = 'compute_jobs';
const WHISPER_JOBS_SUBJECT = 'jobs.whisper';
const LAYOUT_JOBS_SUBJECT = 'jobs.layout';
const WHISPER_CONSUMER_NAME = 'compute_whisper';
const LAYOUT_CONSUMER_NAME = 'compute_layout';
const EVENTS_STREAM_NAME = 'compute_events';
const COMPUTE_STATE_BUCKET = 'compute_state';
const COMPUTE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const LOOP_ERROR_BACKOFF_MS = 500;
const RUNNING_HEARTBEAT_MS = 5000;
const OP_EVENTS_SUBJECT_PREFIX = 'ops.events';
const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const WHISPER_MAX_DELIVER = 1;
const NATS_API_TIMEOUT_MS = 60_000;
// Disconnect from NATS after this much continuous idle so the worker stops
// generating outbound traffic (pull polling + keepalive PINGs) and Railway can
// put it to sleep. Reconnect happens lazily on the next inbound request.
const IDLE_DISCONNECT_MS = 120_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;
// Bounded pull window so consumer loops yield periodically and can be stopped
// cleanly when going idle, instead of blocking on a long-lived pull.
const PULL_EXPIRES_MS = 5_000;
const REQUEST_STARTED_AT_MS_KEY = Symbol('request-started-at-ms');
const REQUEST_COUNTED_KEY = Symbol('request-activity-counted');
const SLOW_JOB_LOG_THRESHOLD_MS_BY_KIND: Record<WorkerOperationKind, number> = {
  whisper_align: 15_000,
  pdf_layout: 120_000,
};

interface QueuedJob<TPayload> {
  jobId: string;
  opId: string;
  opKey: string;
  kind: WorkerOperationKind;
  queuedAt: number;
  payload: TPayload;
}

interface NatsSession {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  kv: Awaited<ReturnType<Kvm['create']>>;
  whisperConsumer: Consumer;
  layoutConsumer: Consumer;
}

type StreamedOperationState = WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult>;

type JsonCodec<T> = {
  encode(value: T): Uint8Array;
  decode(data: Uint8Array): T;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeNatsReplicas(value: number): number {
  if (value === 3 || value === 5) return value;
  return 1;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function buildLoggerConfig(): boolean | Record<string, unknown> {
  const format = (process.env.COMPUTE_LOG_FORMAT?.trim().toLowerCase() || 'pretty');
  const level = process.env.COMPUTE_LOG_LEVEL?.trim() || 'info';
  if (format === 'json') {
    return {
      level,
      base: null,
    };
  }
  return {
    level,
    base: null,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  };
}

function normalizeS3Prefix(prefix: string | undefined): string {
  const value = (prefix || 'openreader').trim();
  return value ? value.replace(/^\/+|\/+$/g, '') : 'openreader';
}

function sanitizeNamespace(namespace: string | null): string | null {
  if (!namespace) return null;
  return SAFE_NAMESPACE_REGEX.test(namespace) ? namespace : null;
}

function documentParsedKey(id: string, namespace: string | null, prefix: string): string {
  if (!DOCUMENT_ID_REGEX.test(id)) {
    throw new Error(`Invalid document id: ${id}`);
  }
  const ns = sanitizeNamespace(namespace);
  const nsSegment = ns ? `ns/${ns}/` : '';
  return `${prefix}/documents_v1/parsed_v1/${nsSegment}${id}.json`;
}

function buildS3Client(): S3Client {
  const bucket = requireEnv('S3_BUCKET');
  const region = requireEnv('S3_REGION');
  const accessKeyId = requireEnv('S3_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('S3_SECRET_ACCESS_KEY');
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  const forcePathStyle = parseBoolEnv('S3_FORCE_PATH_STYLE', false);

  void bucket;

  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === 'object' && body !== null && 'transformToByteArray' in body) {
    const maybe = body as { transformToByteArray?: () => Promise<Uint8Array> };
    if (typeof maybe.transformToByteArray === 'function') {
      return Buffer.from(await maybe.transformToByteArray());
    }
  }
  if (typeof body === 'object' && body !== null && 'on' in body) {
    const stream = body as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
      else chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Unsupported S3 response body type');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isAuthed(request: FastifyRequest, expectedToken: string): boolean {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  return token === expectedToken;
}

function safeDurationMs(start: number | undefined, end: number | undefined): number | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, Math.floor((end as number) - (start as number)));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function requestPath(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? request.url;
}

function isHealthPath(path: string): boolean {
  return path === '/health/live' || path === '/health/ready';
}

function extractTraceId(request: FastifyRequest): string | null {
  const header = request.headers['x-openreader-trace-id'];
  if (Array.isArray(header)) return header[0] ?? null;
  return typeof header === 'string' ? header : null;
}

function extractOpId(request: FastifyRequest, path: string): string | null {
  const params = request.params as { opId?: unknown } | undefined;
  if (params && typeof params.opId === 'string' && params.opId.trim()) {
    return params.opId.trim();
  }
  const match = path.match(/^\/ops\/([^/]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('already in use') || message.includes('already exists');
}

function createJsonCodec<T>(): JsonCodec<T> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    encode(value: T): Uint8Array {
      return encoder.encode(JSON.stringify(value));
    },
    decode(data: Uint8Array): T {
      return JSON.parse(decoder.decode(data)) as T;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ConcurrencyGate {
  private readonly maxInFlight: number;
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.maxInFlight = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  }

  async acquire(): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

function isTerminalStatus(status: WorkerJobState): boolean {
  return status === 'succeeded' || status === 'failed';
}

function extractResultRef(kind: WorkerOperationKind, result: unknown): string | undefined {
  if (kind !== 'pdf_layout' || !result || typeof result !== 'object') return undefined;
  const maybe = result as { parsedObjectKey?: unknown };
  return typeof maybe.parsedObjectKey === 'string' ? maybe.parsedObjectKey : undefined;
}

const alignSchema = z.object({
  text: z.string().trim().min(1),
  lang: z.string().trim().min(1).max(16).optional(),
  cacheKey: z.string().trim().min(1).max(256).optional(),
  audioObjectKey: z.string().trim().min(1).max(2048),
});

const layoutSchema = z.object({
  documentId: z.string().trim().min(1),
  namespace: z.string().trim().min(1).max(128).nullable(),
  documentObjectKey: z.string().trim().min(1).max(2048),
});

const operationCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('whisper_align'),
    opKey: z.string().trim().min(1).max(1024),
    payload: alignSchema,
  }),
  z.object({
    kind: z.literal('pdf_layout'),
    opKey: z.string().trim().min(1).max(1024),
    payload: layoutSchema,
  }),
]);

async function ensureJetStreamResources(
  jsm: JetStreamManager,
  whisperTimeoutMs: number,
  pdfTimeoutMs: number,
  pdfAttempts: number,
  jobsMaxBytes: number,
  eventsMaxBytes: number,
  natsReplicas: number,
): Promise<void> {
  const streamConfig = {
    name: JOBS_STREAM_NAME,
    subjects: [WHISPER_JOBS_SUBJECT, LAYOUT_JOBS_SUBJECT],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_bytes: jobsMaxBytes,
    num_replicas: natsReplicas,
  };

  try {
    await jsm.streams.add(streamConfig);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    await jsm.streams.update(JOBS_STREAM_NAME, {
      subjects: [WHISPER_JOBS_SUBJECT, LAYOUT_JOBS_SUBJECT],
      max_bytes: jobsMaxBytes,
      num_replicas: natsReplicas,
    });
  }

  const eventsStreamConfig = {
    name: EVENTS_STREAM_NAME,
    subjects: [`${OP_EVENTS_SUBJECT_PREFIX}.*`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_bytes: eventsMaxBytes,
    max_age: nanos(COMPUTE_STATE_TTL_MS),
    num_replicas: natsReplicas,
  };

  try {
    await jsm.streams.add(eventsStreamConfig);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    await jsm.streams.update(EVENTS_STREAM_NAME, {
      subjects: [`${OP_EVENTS_SUBJECT_PREFIX}.*`],
      max_bytes: eventsMaxBytes,
      max_age: nanos(COMPUTE_STATE_TTL_MS),
      num_replicas: natsReplicas,
    });
  }

  const ensureConsumer = async (
    name: string,
    subject: string,
    ackWaitMs: number,
    maxDeliver: number,
  ): Promise<void> => {
    const config = {
      durable_name: name,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      replay_policy: ReplayPolicy.Instant,
      filter_subject: subject,
      ack_wait: nanos(Math.max(ackWaitMs, 1_000)),
      max_deliver: maxDeliver,
    };

    try {
      await jsm.consumers.add(JOBS_STREAM_NAME, config);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      await jsm.consumers.update(JOBS_STREAM_NAME, name, {
        filter_subject: subject,
        ack_wait: nanos(Math.max(ackWaitMs, 1_000)),
        max_deliver: maxDeliver,
      });
    }
  };

  await Promise.all([
    ensureConsumer(WHISPER_CONSUMER_NAME, WHISPER_JOBS_SUBJECT, whisperTimeoutMs + 15_000, WHISPER_MAX_DELIVER),
    ensureConsumer(LAYOUT_CONSUMER_NAME, LAYOUT_JOBS_SUBJECT, pdfTimeoutMs + 15_000, pdfAttempts),
  ]);
}

async function main(): Promise<void> {
  const port = readIntEnv('PORT', 8081);
  const host = process.env.COMPUTE_WORKER_HOST?.trim() || '0.0.0.0';
  const workerToken = requireEnv('COMPUTE_WORKER_TOKEN');
  const natsUrl = requireEnv('NATS_URL');
  const timeoutConfig = getComputeTimeoutConfig();

  const jobConcurrency = readIntEnv('COMPUTE_JOB_CONCURRENCY', 1);
  const whisperTimeoutMs = timeoutConfig.whisperTimeoutMs;
  const pdfTimeoutMs = timeoutConfig.pdfTimeoutMs;
  const pdfHardCapMs = timeoutConfig.pdfHardCapMs;
  const pdfAttempts = readIntEnv('COMPUTE_PDF_JOB_ATTEMPTS', 1);
  const prewarmModels = parseBoolEnv('COMPUTE_PREWARM_MODELS', true);
  const jobsStreamMaxBytes = readIntEnv('COMPUTE_JOBS_STREAM_MAX_BYTES', 256 * 1024 * 1024);
  const eventsStreamMaxBytes = readIntEnv('COMPUTE_EVENTS_STREAM_MAX_BYTES', 128 * 1024 * 1024);
  const jobStatesMaxBytes = readIntEnv('COMPUTE_JOB_STATES_MAX_BYTES', 64 * 1024 * 1024);
  const natsReplicas = normalizeNatsReplicas(readIntEnv('COMPUTE_NATS_REPLICAS', 1));
  const opStaleMs = getComputeOpStaleMs();

  const connectOpts: Parameters<typeof connect>[0] = { servers: natsUrl };
  const natsCreds = process.env.NATS_CREDS?.trim();
  const natsCredsFile = process.env.NATS_CREDS_FILE?.trim();

  if (natsCreds) {
    console.log('[compute-worker] Connecting to NATS using credentials string from NATS_CREDS');
    connectOpts.authenticator = credsAuthenticator(new TextEncoder().encode(natsCreds));
  } else if (natsCredsFile) {
    console.log(`[compute-worker] Connecting to NATS using credentials file: ${natsCredsFile}`);
    const { readFileSync } = await import('node:fs');
    const credsData = readFileSync(natsCredsFile);
    connectOpts.authenticator = credsAuthenticator(credsData);
  }

  // Lazy NATS connection lifecycle. The worker connects on demand (first request
  // that needs the queue/KV) and disconnects after IDLE_DISCONNECT_MS of full idle
  // so it stops emitting outbound traffic and Railway can sleep it. Reconnect is
  // transparent: any inbound /ops request both wakes the container and re-establishes
  // the session via ensureConnected().
  let session: NatsSession | null = null;
  let connecting: Promise<NatsSession> | null = null;
  let workerLoops: Promise<void>[] = [];
  let idleTimer: NodeJS.Timeout | null = null;
  let stopping = false;
  let loopStopRequested = false;

  // Activity accounting feeding the idle detector. The worker is considered idle
  // only when no HTTP request is in flight, no SSE stream is open, no job is
  // processing, and nothing has happened for IDLE_DISCONNECT_MS.
  let inFlightHttp = 0;
  let activeSse = 0;
  let inFlightJobs = 0;
  let lastActivityAt = Date.now();
  const jobGate = new ConcurrencyGate(jobConcurrency);

  const markActivity = (): void => {
    lastActivityAt = Date.now();
  };

  function startIdleTimer(): void {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (!session || stopping) return;
      if (inFlightHttp > 0 || activeSse > 0 || inFlightJobs > 0) return;
      if (Date.now() - lastActivityAt < IDLE_DISCONNECT_MS) return;
      void disconnect('idle');
    }, IDLE_CHECK_INTERVAL_MS);
    // Don't let the idle checker keep the process alive on its own.
    idleTimer.unref?.();
  }

  async function disconnect(reason: string): Promise<void> {
    const current = session;
    if (!current) return;
    // Clear synchronously (before any await) so concurrent requests reconnect a
    // fresh session instead of using the connection we're about to close.
    session = null;
    loopStopRequested = true;
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    try {
      await current.nc.close();
    } catch {
      // ignore close errors
    }
    await Promise.allSettled(workerLoops);
    workerLoops = [];
    loopStopRequested = false;
    app.log.info({ reason }, 'nats disconnected');
  }

  async function ensureConnected(): Promise<NatsSession> {
    if (session) return session;
    if (connecting) return connecting;
    connecting = (async () => {
      const nc: NatsConnection = await connect(connectOpts);
      const js: JetStreamClient = jetstream(nc, { timeout: NATS_API_TIMEOUT_MS });
      const jsm: JetStreamManager = await jetstreamManager(nc, { timeout: NATS_API_TIMEOUT_MS });
      await ensureJetStreamResources(
        jsm,
        whisperTimeoutMs,
        pdfTimeoutMs,
        pdfAttempts,
        jobsStreamMaxBytes,
        eventsStreamMaxBytes,
        natsReplicas,
      );
      const kv = await new Kvm(js).create(COMPUTE_STATE_BUCKET, {
        replicas: natsReplicas,
        history: 1,
        ttl: COMPUTE_STATE_TTL_MS,
        max_bytes: jobStatesMaxBytes,
      });
      const whisperConsumer = await js.consumers.get(JOBS_STREAM_NAME, WHISPER_CONSUMER_NAME);
      const layoutConsumer = await js.consumers.get(JOBS_STREAM_NAME, LAYOUT_CONSUMER_NAME);
      const next: NatsSession = { nc, js, jsm, kv, whisperConsumer, layoutConsumer };
      session = next;
      markActivity();
      startWorkerLoops(next);
      startIdleTimer();
      // Safety net: if the connection closes for any reason (network drop after
      // exhausting reconnects, or our own disconnect), drop the stale session so
      // the next request reconnects cleanly.
      void nc.closed().then(() => {
        if (session?.nc === nc) session = null;
      });
      app.log.info('nats connected');
      return next;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  const s3 = buildS3Client();
  const s3Bucket = requireEnv('S3_BUCKET');
  const s3Prefix = normalizeS3Prefix(process.env.S3_PREFIX);

  const ensureSafeKey = (key: string): string => {
    const trimmed = key.trim();
    if (!trimmed.startsWith(`${s3Prefix}/`)) {
      throw new Error('Object key prefix mismatch');
    }
    return trimmed;
  };

  const readObjectByKey = async (key: string): Promise<ArrayBuffer> => {
    const safeKey = ensureSafeKey(key);
    const response = await s3.send(new GetObjectCommand({
      Bucket: s3Bucket,
      Key: safeKey,
    }));
    const bytes = await bodyToBuffer(response.Body);
    return toArrayBuffer(new Uint8Array(bytes));
  };

  const putParsedObject = async (documentId: string, namespace: string | null, parsed: unknown): Promise<string> => {
    const key = documentParsedKey(documentId, namespace, s3Prefix);
    const body = Buffer.from(JSON.stringify(parsed));
    await s3.send(new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
    return key;
  };

  if (prewarmModels) {
    await ensureComputeModels();
  }

  const app = Fastify({
    logger: buildLoggerConfig(),
    disableRequestLogging: true,
  });
  app.log.info({
    jobConcurrency,
    whisperTimeoutMs,
    pdfTimeoutMs,
    pdfAttempts,
    opStaleMs,
    availableCpuCores: getAvailableCpuCores(),
    onnxThreadsPerJob: getOnnxThreadsPerJob(),
    natsApiTimeoutMs: NATS_API_TIMEOUT_MS,
    natsReplicas,
    eventsStreamMaxBytes,
    pdfLayoutHardCapMs: pdfHardCapMs,
  }, 'compute runtime config');

  const whisperJobCodec = createJsonCodec<QueuedJob<WhisperAlignJobRequest>>();
  const layoutJobCodec = createJsonCodec<QueuedJob<PdfLayoutJobRequest>>();

  const operationStateStore = new JetStreamOperationStateStore<WhisperAlignJobResult | PdfLayoutJobResult>({
    getKv: async () => (await ensureConnected()).kv,
  });

  const operationEventStream = new JetStreamOperationEventStream<WhisperAlignJobResult | PdfLayoutJobResult>({
    getJs: async () => (await ensureConnected()).js,
    getJsm: async () => (await ensureConnected()).jsm,
    eventsStreamName: EVENTS_STREAM_NAME,
  });

  const operationQueue = new JetStreamOperationQueue({
    getJs: async () => (await ensureConnected()).js,
    whisperSubject: WHISPER_JOBS_SUBJECT,
    layoutSubject: LAYOUT_JOBS_SUBJECT,
  });

  const orchestrator = new OperationOrchestrator({
    queue: operationQueue,
    stateStore: operationStateStore,
    eventStream: operationEventStream,
    config: {
      opStaleMs,
      maxCasRetries: 10,
    },
  });

  const getOpState = async (opId: string): Promise<StreamedOperationState | null> => {
    return await operationStateStore.getOpState(opId);
  };

  const releaseHttp = (request: FastifyRequest): void => {
    const counted = request as FastifyRequest & { [REQUEST_COUNTED_KEY]?: boolean };
    if (!counted[REQUEST_COUNTED_KEY]) return;
    counted[REQUEST_COUNTED_KEY] = false;
    inFlightHttp = Math.max(0, inFlightHttp - 1);
    markActivity();
  };

  app.addHook('onRequest', async (request, reply) => {
    const path = requestPath(request);
    (request as FastifyRequest & { [REQUEST_STARTED_AT_MS_KEY]?: number })[REQUEST_STARTED_AT_MS_KEY] = Date.now();
    // Count every request as in-flight activity so the idle detector never
    // disconnects mid-request. Released in onResponse, or manually after hijack
    // for SSE streams (where onResponse does not fire).
    (request as FastifyRequest & { [REQUEST_COUNTED_KEY]?: boolean })[REQUEST_COUNTED_KEY] = true;
    inFlightHttp += 1;
    markActivity();
    if (isHealthPath(path)) return;
    if (!isAuthed(request, workerToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    return;
  });

  app.addHook('onResponse', async (request, reply) => {
    releaseHttp(request);
    const path = requestPath(request);
    if (isHealthPath(path)) return;
    if (reply.statusCode >= 500) {
      const startedAt = (request as FastifyRequest & { [REQUEST_STARTED_AT_MS_KEY]?: number })[REQUEST_STARTED_AT_MS_KEY];
      const durationMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - (startedAt as number)) : -1;
      app.log.error({
        reqId: request.id,
        method: request.method,
        path,
        statusCode: reply.statusCode,
        durationMs,
        traceId: extractTraceId(request) ?? null,
        opId: extractOpId(request, path),
      }, 'http.error');
    }
  });

  app.get('/health/live', async () => ({ ok: true }));

  // Reports readiness without forcing a NATS round-trip. Probing NATS here would
  // reconnect (and keep) the connection open, defeating idle sleep, so we only
  // report the current connection state. The worker reconnects lazily on the next
  // /ops request regardless of what this returns.
  app.get('/health/ready', async () => ({ ok: true, natsConnected: session !== null }));

  app.post('/ops', async (request, reply) => {
    const parsed = operationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid request body',
        issues: parsed.error.issues,
      };
    }

    const requestOp = parsed.data as WorkerOperationRequest;
    const op = await orchestrator.enqueueOrReuse(requestOp);
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return op;
  });

  app.get('/ops/:opId', async (request, reply) => {
    const params = z.object({ opId: z.string().trim().min(1) }).safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid op id' };
    }

    const state = await getOpState(params.data.opId);
    if (!state) {
      reply.code(404);
      return { error: 'Operation not found' };
    }

    return state;
  });

  app.get('/ops/:opId/events', async (request, reply) => {
    const params = z.object({ opId: z.string().trim().min(1) }).safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid op id' };
    }

    const initial = await getOpState(params.data.opId);
    if (!initial) {
      reply.code(404);
      return { error: 'Operation not found' };
    }

    const cursorQueryRaw = request.query as { sinceEventId?: string | number | null } | undefined;
    const cursorFromQuery = Number(cursorQueryRaw?.sinceEventId ?? 0);
    const lastEventIdHeader = request.headers['last-event-id'];
    const cursorFromHeader = Number(
      Array.isArray(lastEventIdHeader) ? (lastEventIdHeader[0] ?? 0) : (lastEventIdHeader ?? 0),
    );
    const sinceEventId = Math.max(
      0,
      Number.isFinite(cursorFromQuery) ? Math.floor(cursorFromQuery) : 0,
      Number.isFinite(cursorFromHeader) ? Math.floor(cursorFromHeader) : 0,
    );

    reply.hijack();
    // onResponse will not fire for a hijacked reply, so release the HTTP in-flight
    // count here and track the long-lived stream via activeSse instead.
    releaseHttp(request);
    activeSse += 1;
    markActivity();
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');

    let closed = false;
    let unsubscribe: (() => void) | null = null;

    const writeSnapshot = (snapshot: StreamedOperationState, eventId: number): void => {
      if (closed || reply.raw.writableEnded) return;
      const frameEvent: WorkerOperationEvent<WhisperAlignJobResult | PdfLayoutJobResult> = {
        eventId,
        snapshot,
      };
      reply.raw.write(encodeSseFrame({
        id: eventId,
        event: 'snapshot',
        data: frameEvent,
      }));
    };

    const closeStream = (): void => {
      if (closed) return;
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      activeSse = Math.max(0, activeSse - 1);
      markActivity();
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    request.raw.on('close', () => {
      closeStream();
    });

    try {
      let current = initial;
      let signature = JSON.stringify(current);
      writeSnapshot(current, sinceEventId > 0 ? sinceEventId : 0);
      if (isTerminalStatus(current.status)) {
        return reply;
      }

      unsubscribe = await operationEventStream.subscribe({
        opId: params.data.opId,
        sinceEventId,
        onEvent: (event) => {
          if (closed) return;
          if (event.snapshot.opId !== params.data.opId) return;
          const nextSignature = JSON.stringify(event.snapshot);
          if (nextSignature !== signature) {
            current = event.snapshot;
            signature = nextSignature;
            writeSnapshot(current, event.eventId);
          }
          if (isTerminalStatus(event.snapshot.status)) {
            closeStream();
          }
        },
        onError: (error) => {
          app.log.warn({
            opId: params.data.opId,
            error: toErrorMessage(error),
          }, 'op events stream loop error');
          closeStream();
        },
      });

      await new Promise<void>((resolve) => {
        request.raw.once('close', () => resolve());
      });
    } catch (error) {
      app.log.warn({
        opId: params.data.opId,
        error: toErrorMessage(error),
      }, 'op events stream loop error');
    } finally {
      closeStream();
    }

    return reply;
  });

  const runWhisper = async (
    payload: WhisperAlignJobRequest,
    queueWaitMs: number,
  ): Promise<WhisperAlignJobResult> => {
    const parsed = alignSchema.parse(payload);

    const s3FetchStartedAt = Date.now();
    const audioBuffer = await readObjectByKey(parsed.audioObjectKey);
    const s3FetchMs = Date.now() - s3FetchStartedAt;

    const computeStartedAt = Date.now();
    const result = await withTimeout(
      runWhisperAlignmentFromAudioBuffer({
        audioBuffer,
        text: parsed.text,
        cacheKey: parsed.cacheKey,
        lang: parsed.lang,
      }),
      whisperTimeoutMs,
      'whisper alignment job',
    );

    const computeMs = Date.now() - computeStartedAt;
    return {
      ...result,
      timing: {
        queueWaitMs,
        s3FetchMs,
        computeMs,
      },
    };
  };

  const runLayout = async (
    payload: PdfLayoutJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: PdfLayoutProgress) => Promise<void> },
  ): Promise<PdfLayoutJobResult> => {
    const parsed = layoutSchema.parse(payload);

    const s3FetchStartedAt = Date.now();
    const pdfBytes = await readObjectByKey(parsed.documentObjectKey);
    const s3FetchMs = Date.now() - s3FetchStartedAt;

    let lastTotalPages = 0;
    let lastPagesParsed = 0;
    const computeStartedAt = Date.now();
    const result = await withIdleTimeoutAndHardCap({
      idleTimeoutMs: Math.max(pdfTimeoutMs, 1_000),
      hardCapMs: pdfHardCapMs,
      label: 'pdf layout job',
      run: async (touchProgress) => runPdfLayoutFromPdfBuffer({
        documentId: parsed.documentId,
        pdfBytes,
        onPageParsed: async ({ pageNumber, totalPages }) => {
          touchProgress();
          lastTotalPages = totalPages;
          lastPagesParsed = pageNumber;
          if (!hooks?.onProgress) return;
          await hooks.onProgress({
            totalPages,
            pagesParsed: pageNumber,
            currentPage: pageNumber,
            phase: 'infer',
          });
        },
      }),
    });

    const computeMs = Date.now() - computeStartedAt;
    if (hooks?.onProgress && lastTotalPages > 0) {
      await hooks.onProgress({
        totalPages: lastTotalPages,
        pagesParsed: lastPagesParsed,
        currentPage: lastPagesParsed || undefined,
        phase: 'merge',
      });
    }
    const parsedObjectKey = await putParsedObject(parsed.documentId, parsed.namespace, result.parsed);
    return {
      parsedObjectKey,
      timing: {
        queueWaitMs,
        s3FetchMs,
        computeMs,
      },
    };
  };

  async function processMessage<TPayload, TResult>(input: {
    msg: JsMsg;
    codec: JsonCodec<QueuedJob<TPayload>>;
    run: (
      payload: TPayload,
      queueWaitMs: number,
      hooks?: { onProgress?: (progress: PdfLayoutProgress) => Promise<void> },
    ) => Promise<TResult>;
    workerLabel: string;
  }): Promise<void> {
    let decoded: QueuedJob<TPayload> | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let latestProgress: PdfLayoutProgress | undefined;
    try {
      decoded = input.codec.decode(input.msg.data);
      const startedAt = Date.now();
      const queueWaitMs = safeDurationMs(decoded.queuedAt, startedAt);
      const queueWaitTiming = typeof queueWaitMs === 'number' ? { queueWaitMs } : undefined;

      await orchestrator.markRunning({
        opId: decoded.opId,
        startedAt,
        updatedAt: startedAt,
        ...(queueWaitTiming ? { timing: queueWaitTiming } : {}),
      });
      app.log.info({
        worker: input.workerLabel,
        kind: decoded.kind,
        opId: decoded.opId,
        jobId: decoded.jobId,
        queueWaitMs: queueWaitMs ?? null,
        deliveryCount: input.msg.info.deliveryCount,
      }, 'job.started');

      const persistRunningState = async (updatedAt: number): Promise<void> => {
        if (latestProgress) {
          await orchestrator.markProgress({
            opId: decoded!.opId,
            progress: latestProgress,
            updatedAt,
            ...(queueWaitTiming ? { timing: queueWaitTiming } : {}),
          });
        } else {
          await orchestrator.markRunning({
            opId: decoded!.opId,
            startedAt,
            updatedAt,
            ...(queueWaitTiming ? { timing: queueWaitTiming } : {}),
          });
        }
      };

      heartbeat = setInterval(() => {
        const now = Date.now();
        void persistRunningState(now).catch((stateError) => {
          app.log.error({
            worker: input.workerLabel,
            opId: decoded?.opId,
            jobId: decoded?.jobId,
            error: toErrorMessage(stateError),
          }, 'failed to persist operation heartbeat state');
        });
      }, RUNNING_HEARTBEAT_MS);

      const result = await input.run(decoded.payload, queueWaitMs ?? 0, {
        onProgress: async (progress) => {
          latestProgress = progress;
          await persistRunningState(Date.now());
        },
      });
      const resultTiming = result && typeof result === 'object' && 'timing' in result
        ? (result as { timing?: WorkerJobTiming }).timing
        : undefined;
      const now = Date.now();

      await orchestrator.markSucceeded({
        opId: decoded.opId,
        result: result as WhisperAlignJobResult | PdfLayoutJobResult,
        updatedAt: now,
        ...(resultTiming ? { timing: resultTiming } : {}),
      });

      input.msg.ack();
      const terminalDurationMs = safeDurationMs(startedAt, now);
      const slowJobLogThresholdMs = SLOW_JOB_LOG_THRESHOLD_MS_BY_KIND[decoded.kind];
      if ((terminalDurationMs ?? 0) >= slowJobLogThresholdMs) {
        app.log.info({
          worker: input.workerLabel,
          kind: decoded.kind,
          opId: decoded.opId,
          jobId: decoded.jobId,
          durationMs: terminalDurationMs ?? null,
          timing: resultTiming ?? null,
        }, 'job.stage');
      }
      app.log.info({
        worker: input.workerLabel,
        kind: decoded.kind,
        opId: decoded.opId,
        jobId: decoded.jobId,
        status: 'succeeded',
        durationMs: terminalDurationMs ?? null,
        resultRef: extractResultRef(decoded.kind, result),
        timing: resultTiming ?? null,
      }, 'job.terminal');
    } catch (error) {
      const message = toErrorMessage(error);
      const deliveryCount = input.msg.info.deliveryCount;
      const isWhisperAlign = decoded?.kind === 'whisper_align';
      const maxAttempts = isWhisperAlign ? WHISPER_MAX_DELIVER : pdfAttempts;
      const hasRetriesLeft = !isWhisperAlign && deliveryCount < maxAttempts;

      if (decoded) {
        const now = Date.now();
        const queueWaitMs = safeDurationMs(decoded.queuedAt, now);
        const queueWaitTiming = typeof queueWaitMs === 'number' ? { queueWaitMs } : undefined;

        const persistOpUpdate = hasRetriesLeft
          ? (latestProgress
            ? orchestrator.markProgress({
              opId: decoded.opId,
              progress: latestProgress,
              updatedAt: now,
              ...(queueWaitTiming ? { timing: queueWaitTiming } : {}),
            })
            : orchestrator.markRunning({
              opId: decoded.opId,
              updatedAt: now,
              ...(queueWaitTiming ? { timing: queueWaitTiming } : {}),
            }))
          : orchestrator.markFailed({
            opId: decoded.opId,
            error: { message },
            updatedAt: now,
            ...(queueWaitTiming ? { timing: queueWaitTiming } : {}),
          });

        await persistOpUpdate.catch((stateError) => {
          app.log.error({
            worker: input.workerLabel,
            opId: decoded?.opId,
            jobId: decoded?.jobId,
            error: toErrorMessage(stateError),
          }, 'failed to persist operation state');
        });
      }

      if (hasRetriesLeft) {
        input.msg.nak();
        app.log.error({
          worker: input.workerLabel,
          kind: decoded?.kind,
          opId: decoded?.opId,
          jobId: decoded?.jobId,
          status: 'running',
          error: message,
          deliveryCount,
          maxAttempts,
          retryAction: 'nack_retry',
        }, 'job.terminal');
      } else {
        input.msg.term(message);
        app.log.error({
          worker: input.workerLabel,
          kind: decoded?.kind,
          opId: decoded?.opId,
          jobId: decoded?.jobId,
          status: 'failed',
          error: message,
          deliveryCount,
          maxAttempts,
          retrySuppressed: isWhisperAlign ? 'whisper_align' : undefined,
          retryAction: 'term',
        }, 'job.terminal');
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async function createWorkerLoop<TPayload, TResult>(input: {
    owner: NatsSession;
    consumer: Consumer;
    codec: JsonCodec<QueuedJob<TPayload>>;
    run: (
      payload: TPayload,
      queueWaitMs: number,
      hooks?: { onProgress?: (progress: PdfLayoutProgress) => Promise<void> },
    ) => Promise<TResult>;
    workerLabel: string;
  }): Promise<void> {
    // Exit when the loop's connection is no longer the active session (idle
    // disconnect, unexpected close, or replaced by a reconnect).
    const detached = (): boolean => stopping || loopStopRequested || session !== input.owner;
    while (!detached()) {
      let msg: JsMsg | null = null;
      try {
        try {
          // Bounded pull so the loop yields periodically and exits promptly when
          // the session is torn down for idle (nc.close() rejects the pending pull).
          msg = await input.consumer.next({ expires: PULL_EXPIRES_MS });
        } catch (error) {
          if (detached()) return;
          app.log.error({ error: toErrorMessage(error), worker: input.workerLabel }, 'worker pull failed');
          await sleep(LOOP_ERROR_BACKOFF_MS);
          continue;
        }

        // An empty pull is not activity; let the idle window advance.
        if (!msg) continue;
        markActivity();
        inFlightJobs += 1;
        await jobGate.acquire();
        if (detached()) {
          return;
        }
        await processMessage({
          msg,
          codec: input.codec,
          run: input.run,
          workerLabel: input.workerLabel,
        });
      } finally {
        if (msg) {
          jobGate.release();
          inFlightJobs = Math.max(0, inFlightJobs - 1);
          markActivity();
        }
      }
    }
  }

  function startWorkerLoops(active: NatsSession): void {
    // Always starts a fresh set bound to the new session. Any loops from a prior
    // session self-terminate once they observe session !== their owner.
    workerLoops = [];
    loopStopRequested = false;
    for (let i = 0; i < jobConcurrency; i += 1) {
      workerLoops.push(createWorkerLoop({
        owner: active,
        consumer: active.whisperConsumer,
        codec: whisperJobCodec,
        run: runWhisper,
        workerLabel: `whisper-${i + 1}`,
      }));
    }
    for (let i = 0; i < jobConcurrency; i += 1) {
      workerLoops.push(createWorkerLoop({
        owner: active,
        consumer: active.layoutConsumer,
        codec: layoutJobCodec,
        run: runLayout,
        workerLabel: `layout-${i + 1}`,
      }));
    }
  }

  const close = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    await app.close();
    await Promise.allSettled(workerLoops);
    const current = session;
    session = null;
    if (current) {
      try {
        await current.nc.drain();
      } catch {
        try {
          await current.nc.close();
        } catch {
          // ignore close errors
        }
      }
    }
  };

  process.once('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });

  await app.listen({ host, port });
  app.log.info({ host, port }, 'compute worker listening');
}

void main().catch((error) => {
  console.error('[compute-worker] fatal startup error', error);
  process.exit(1);
});
