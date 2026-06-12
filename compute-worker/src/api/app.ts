import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import {
  connect,
  credsAuthenticator,
  type NatsConnection,
} from '@nats-io/transport-node';
import {
  jetstream,
  jetstreamManager,
  type Consumer,
  type JetStreamClient,
  type JetStreamManager,
} from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import {
  ensureComputeModels,
} from '../inference/runtime';
import {
  getComputeTimeoutConfig,
  getComputeOpStaleMs,
  getAvailableCpuCores,
  getOnnxThreadsPerJob,
} from '../infrastructure/config';
import { encodeSseFrame, OperationOrchestrator } from '../operations';
import type {
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  WorkerOperationEvent,
  WhisperAlignJobRequest,
  WhisperAlignJobResult,
  WorkerJobTiming,
  WorkerOperationRequest,
  WorkerOperationState,
} from '../api/contracts';
import {
  JetStreamOperationEventStream,
  JetStreamOperationQueue,
  JetStreamOperationStateStore,
  hashOpKey,
} from '../infrastructure/nats-adapters';
import { createJsonCodec } from '../infrastructure/json-codec';
import {
  recoverOrphanedOperations,
  type StreamedOperationState,
} from '../operations/recovery';
import { parsedPdfArtifactKey } from '../storage/artifact-addressing';
import {
  createArtifactStorage,
  createS3ClientFromEnv,
  normalizeS3Prefix,
  type ArtifactStorage,
} from '../infrastructure/storage';
import { createJobHandlers } from '../jobs/handlers';
import { createWorkerLoopController, type QueuedJob } from '../jobs/worker-loop';
import {
  COMPUTE_STATE_BUCKET,
  COMPUTE_STATE_TTL_MS,
  EVENTS_STREAM_NAME,
  JOBS_STREAM_NAME,
  LAYOUT_CONSUMER_NAME,
  LAYOUT_JOBS_SUBJECT,
  NATS_API_TIMEOUT_MS,
  WHISPER_CONSUMER_NAME,
  WHISPER_JOBS_SUBJECT,
  ensureJetStreamResources,
} from '../infrastructure/nats';
import { buildPdfOperationKey, buildWhisperOperationKey } from './operation-keys';
import { toPublicOperation, type PublicOperationEvent } from './public-operation';
import {
  apiErrorResponseSchema,
  artifactReferenceSchema,
  jsonSchema,
  operationEventsQuerySchema,
  operationParamsSchema,
  operationErrorSchema,
  parsedPdfDocumentSchema,
  pdfLayoutProgressSchema,
  pdfLayoutResolutionSchema,
  pdfOperationCreateSchema,
  pdfResolveSchema,
  publicOperationEventSchema,
  publicOperationSchema,
  ttsSentenceAlignmentSchema,
  whisperOperationCreateSchema,
} from './schemas';

const OP_EVENTS_KEEPALIVE_MS = 15_000;
// Reconnection delay handed to the browser EventSource via the SSE `retry:`
// directive. When a silent stream is torn down for idle sleep, this keeps the
// client from immediately reconnecting and re-waking the worker; instead it
// reconnects on a slow cadence so the container stays asleep most of the time.
const OP_EVENTS_RECONNECT_HINT_MS = 120_000;
// Disconnect from NATS after this much continuous idle so the worker stops
// generating outbound traffic (pull polling + keepalive PINGs) and Railway can
// put it to sleep. Reconnect happens lazily on the next inbound request.
const IDLE_DISCONNECT_MS = 120_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;
const IDLE_STATUS_LOG_INTERVAL_MS = 60_000;
const ORPHAN_SWEEP_INTERVAL_MS = 15_000;
// Bounded pull window so consumer loops yield periodically and can be stopped
// cleanly when going idle, instead of blocking on a long-lived pull.
const REQUEST_STARTED_AT_MS_KEY = Symbol('request-started-at-ms');
const REQUEST_COUNTED_KEY = Symbol('request-activity-counted');
const WHISPER_MAX_DELIVER = 1;

interface NatsSession {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  kv: Awaited<ReturnType<Kvm['create']>>;
  whisperConsumer: Consumer;
  layoutConsumer: Consumer;
}

interface OperationEventStreamLike {
  subscribe(input: {
    opId: string;
    sinceEventId?: number;
    onEvent: (event: WorkerOperationEvent<WhisperAlignJobResult | PdfLayoutJobResult>) => void | Promise<void>;
    onError?: (error: unknown) => void;
  }): Promise<() => void>;
}

interface OperationStateStoreLike {
  getOpState(opId: string): Promise<StreamedOperationState | null>;
  getOpStateRecord?(opId: string): Promise<{ state: StreamedOperationState; revision: number } | null>;
  getOpIndex?(opKey: string): Promise<{ opId: string } | null>;
  listOpStates?(): Promise<StreamedOperationState[]>;
}

interface OrchestratorLike {
  enqueueOrReuse(request: WorkerOperationRequest): Promise<StreamedOperationState>;
  markRunning(input: {
    opId: string;
    startedAt?: number;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<StreamedOperationState>;
  markProgress(input: {
    opId: string;
    progress: WorkerOperationState['progress'];
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<StreamedOperationState>;
  markSucceeded(input: {
    opId: string;
    result: unknown;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<StreamedOperationState>;
  markFailed(input: {
    opId: string;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<StreamedOperationState>;
  markFailedIfUnchanged?(input: {
    current: StreamedOperationState;
    expectedRevision: number;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<StreamedOperationState | null>;
}

export interface ComputeWorkerRouteDeps {
  orchestrator: OrchestratorLike;
  operationStateStore: OperationStateStoreLike;
  operationEventStream: OperationEventStreamLike;
  artifactExists?: (key: string) => Promise<boolean>;
}

export interface CreateComputeWorkerAppOptions {
  host?: string;
  port?: number;
  workerToken?: string;
  routeDeps?: ComputeWorkerRouteDeps;
  disableWorkers?: boolean;
}

export interface ComputeWorkerApp {
  app: FastifyInstance;
  host: string;
  port: number;
  start(options?: { registerSignalHandlers?: boolean }): Promise<void>;
  close(): Promise<void>;
}

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
  const format = (process.env.LOG_FORMAT?.trim().toLowerCase() || 'pretty');
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

function isAuthed(request: FastifyRequest, expectedToken: string): boolean {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  return token === expectedToken;
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
  const match = path.match(/^\/v1\/operations\/([^/]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isTerminalStatus(status: import('../api/contracts').WorkerJobState): boolean {
  return status === 'succeeded' || status === 'failed';
}

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

export async function createComputeWorkerApp(options: CreateComputeWorkerAppOptions = {}): Promise<ComputeWorkerApp> {
  const port = options.port ?? readIntEnv('PORT', 8081);
  const host = options.host ?? (process.env.COMPUTE_WORKER_HOST?.trim() || '0.0.0.0');
  const workerToken = options.workerToken ?? requireEnv('COMPUTE_WORKER_TOKEN');
  const disableWorkers = options.disableWorkers ?? false;
  const natsUrl = requireEnv('NATS_URL');
  const timeoutConfig = getComputeTimeoutConfig();

  const jobConcurrency = readIntEnv('COMPUTE_JOB_CONCURRENCY', 1);
  const whisperTimeoutMs = timeoutConfig.whisperTimeoutMs;
  const pdfTimeoutMs = timeoutConfig.pdfTimeoutMs;
  const pdfHardCapMs = timeoutConfig.pdfHardCapMs;
  const pdfAttempts = readIntEnv('COMPUTE_PDF_JOB_ATTEMPTS', 1);
  const prewarmModels = parseBoolEnv('COMPUTE_PREWARM_MODELS', false);
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
  // transparent: any inbound operation request both wakes the container and re-establishes
  // the session via ensureConnected().
  let session: NatsSession | null = null;
  let connecting: Promise<NatsSession> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let orphanSweepTimer: NodeJS.Timeout | null = null;
  let stopping = false;

  // Activity accounting feeding the idle detector. The worker is considered idle
  // only when no HTTP request is in flight, no SSE stream is open, no job is
  // processing, and nothing has happened for IDLE_DISCONNECT_MS.
  let inFlightHttp = 0;
  let activeSse = 0;
  let inFlightJobs = 0;
  let lastActivityAt = Date.now();
  let lastActivityReason = 'startup';
  let lastIdleStatusLogAt = 0;

  const markActivity = (reason: string): void => {
    lastActivityAt = Date.now();
    lastActivityReason = reason;
  };

  function startIdleTimer(): void {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (!session || stopping) return;
      const now = Date.now();
      const idleForMs = now - lastActivityAt;
      if (now - lastIdleStatusLogAt >= IDLE_STATUS_LOG_INTERVAL_MS) {
        lastIdleStatusLogAt = now;
        app.log.info({
          activeSse,
          idleForMs,
          inFlightHttp,
          inFlightJobs,
          lastActivityReason,
          disconnectEligible: inFlightHttp === 0
            && inFlightJobs === 0
            && idleForMs >= IDLE_DISCONNECT_MS,
        }, 'nats idle status');
      }
      // Hard work in flight always blocks idle. An open SSE no longer blocks just
      // by existing — only by delivering events, which refresh lastActivityAt via
      // markActivity() in the stream's onEvent. So a silent/stuck-op stream lets
      // the idle window elapse and is torn down by disconnect() below.
      if (inFlightHttp > 0 || inFlightJobs > 0) return;
      if (idleForMs < IDLE_DISCONNECT_MS) return;
      void disconnect('idle');
    }, IDLE_CHECK_INTERVAL_MS);
    // Don't let the idle checker keep the process alive on its own.
    idleTimer.unref?.();
  }

  function startOrphanSweepTimer(): void {
    if (orphanSweepTimer) return;
    orphanSweepTimer = setInterval(() => {
      if (!session || stopping) return;
      void runOrphanedOpRecovery({ force: true }).catch((error) => {
        app.log.error({
          error: toErrorMessage(error),
        }, 'periodic orphaned operation recovery failed');
      });
    }, ORPHAN_SWEEP_INTERVAL_MS);
    orphanSweepTimer.unref?.();
  }

  async function disconnect(reason: string): Promise<void> {
    const current = session;
    if (!current) return;
    // Snapshot what's still attached so a dropped connection is visible in logs
    // (e.g. SSE streams torn down because we went idle while they were open).
    app.log.info({
      reason,
      activeSse,
      inFlightHttp,
      inFlightJobs,
      idleForMs: Date.now() - lastActivityAt,
    }, 'nats dropping connection');
    // Clear synchronously (before any await) so concurrent requests reconnect a
    // fresh session instead of using the connection we're about to close.
    session = null;
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    if (orphanSweepTimer) {
      clearInterval(orphanSweepTimer);
      orphanSweepTimer = null;
    }
    try {
      await current.nc.close();
    } catch {
      // ignore close errors
    }
    await workerLoops.stop();
    app.log.info({ reason }, 'nats disconnected');
  }

  async function ensureConnected(): Promise<NatsSession> {
    if (session) return session;
    if (connecting) return connecting;
    connecting = (async () => {
      const nc: NatsConnection = await connect(connectOpts);
      const js: JetStreamClient = jetstream(nc, { timeout: NATS_API_TIMEOUT_MS });
      const jsm: JetStreamManager = await jetstreamManager(nc, { timeout: NATS_API_TIMEOUT_MS });
      await ensureJetStreamResources({
        jsm,
        whisperTimeoutMs,
        pdfTimeoutMs,
        pdfAttempts,
        jobsMaxBytes: jobsStreamMaxBytes,
        eventsMaxBytes: eventsStreamMaxBytes,
        natsReplicas,
      });
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
      sessionGeneration += 1;
      orphanRecoveryDoneForGeneration = -1;
      markActivity('nats_connected');
      if (!disableWorkers) {
        workerLoops.start(next, {
          whisper: next.whisperConsumer,
          pdfLayout: next.layoutConsumer,
        });
      }
      startIdleTimer();
      startOrphanSweepTimer();
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

  const s3Prefix = normalizeS3Prefix(process.env.S3_PREFIX);
  const storageDisabled = async (): Promise<never> => {
    throw new Error('S3 access is disabled for this worker app instance');
  };
  const storage: ArtifactStorage = disableWorkers
    ? {
      readObject: storageDisabled,
      objectExists: storageDisabled,
      deleteObject: storageDisabled,
      putParsedPdf: storageDisabled,
    }
    : createArtifactStorage({
      bucket: requireEnv('S3_BUCKET'),
      prefix: s3Prefix,
      client: createS3ClientFromEnv(requireEnv),
    });

  if (prewarmModels && !disableWorkers) {
    await ensureComputeModels();
  }

  const app = Fastify({
    logger: buildLoggerConfig(),
    disableRequestLogging: true,
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'OpenReader Compute Worker API',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
        schemas: {
          ParsedPdfDocument: jsonSchema(parsedPdfDocumentSchema),
          TTSSentenceAlignment: jsonSchema(ttsSentenceAlignmentSchema),
          ArtifactReference: jsonSchema(artifactReferenceSchema),
          ErrorResponse: jsonSchema(apiErrorResponseSchema),
          OperationError: jsonSchema(operationErrorSchema),
          PdfLayoutProgress: jsonSchema(pdfLayoutProgressSchema),
          PublicOperation: jsonSchema(publicOperationSchema),
          PublicOperationEvent: jsonSchema(publicOperationEventSchema),
          PdfLayoutResolution: jsonSchema(pdfLayoutResolutionSchema),
        },
      },
      security: [{ bearerAuth: [] }],
    },
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

  const defaultOperationStateStore = new JetStreamOperationStateStore<WhisperAlignJobResult | PdfLayoutJobResult>({
    getKv: async () => (await ensureConnected()).kv,
  });

  const defaultOperationEventStream = new JetStreamOperationEventStream<WhisperAlignJobResult | PdfLayoutJobResult>({
    getJs: async () => (await ensureConnected()).js,
    getJsm: async () => (await ensureConnected()).jsm,
    eventsStreamName: EVENTS_STREAM_NAME,
  });

  const operationQueue = new JetStreamOperationQueue({
    getJs: async () => (await ensureConnected()).js,
    whisperSubject: WHISPER_JOBS_SUBJECT,
    layoutSubject: LAYOUT_JOBS_SUBJECT,
  });

  const defaultOrchestrator = new OperationOrchestrator({
    queue: operationQueue,
    stateStore: defaultOperationStateStore,
    eventStream: defaultOperationEventStream,
    config: {
      opStaleMs,
      maxCasRetries: 10,
    },
  });

  const operationStateStore = options.routeDeps?.operationStateStore ?? defaultOperationStateStore;
  const operationEventStream = options.routeDeps?.operationEventStream ?? defaultOperationEventStream;
  const orchestrator = options.routeDeps?.orchestrator ?? defaultOrchestrator;
  let orphanRecoveryPromise: Promise<void> | null = null;
  let orphanRecoveryDoneForGeneration = -1;
  let sessionGeneration = options.routeDeps ? 0 : -1;

  const runOrphanedOpRecovery = async (options?: { force?: boolean }): Promise<void> => {
    if (typeof operationStateStore.listOpStates !== 'function') return;
    if (typeof operationStateStore.getOpStateRecord !== 'function') return;
    if (typeof orchestrator.markFailedIfUnchanged !== 'function') return;
    if (!options?.force && orphanRecoveryDoneForGeneration === sessionGeneration) return;
    if (orphanRecoveryPromise) {
      await orphanRecoveryPromise;
      return;
    }

    orphanRecoveryPromise = (async () => {
      const recoveredStates = await recoverOrphanedOperations({
        operationStateStore: operationStateStore as typeof operationStateStore & {
          getOpStateRecord(opId: string): Promise<{ state: StreamedOperationState; revision: number } | null>;
          listOpStates(): Promise<StreamedOperationState[]>;
        },
        orchestrator: orchestrator as typeof orchestrator & {
          markFailedIfUnchanged(input: {
            current: StreamedOperationState;
            expectedRevision: number;
            error: { message: string; code?: string } | string;
            updatedAt?: number;
            timing?: WorkerJobTiming;
          }): Promise<StreamedOperationState | null>;
        },
        whisperTimeoutMs,
        pdfTimeoutMs,
        opStaleMs,
      });

      if (recoveredStates.length > 0) {
        app.log.warn({
          recoveredCount: recoveredStates.length,
          ops: recoveredStates.map((state) => ({
            opId: state.opId,
            kind: state.kind,
            status: state.status,
          })),
        }, 'recovered stale in-flight operations during reconciliation');
      }

      orphanRecoveryDoneForGeneration = sessionGeneration;
    })().finally(() => {
      orphanRecoveryPromise = null;
    });

    await orphanRecoveryPromise;
  };

  const ensureOrphanedOpRecovery = async (): Promise<void> => {
    await runOrphanedOpRecovery();
  };

  const getOpState = async (opId: string): Promise<StreamedOperationState | null> => {
    await ensureOrphanedOpRecovery();
    return await operationStateStore.getOpState(opId);
  };

  const releaseHttp = (request: FastifyRequest): void => {
    const counted = request as FastifyRequest & { [REQUEST_COUNTED_KEY]?: boolean };
    if (!counted[REQUEST_COUNTED_KEY]) return;
    counted[REQUEST_COUNTED_KEY] = false;
    inFlightHttp = Math.max(0, inFlightHttp - 1);
    markActivity('http_completed');
  };

  app.addHook('onRequest', async (request, reply) => {
    const path = requestPath(request);
    (request as FastifyRequest & { [REQUEST_STARTED_AT_MS_KEY]?: number })[REQUEST_STARTED_AT_MS_KEY] = Date.now();
    // Count every request as in-flight activity so the idle detector never
    // disconnects mid-request. Released in onResponse, or manually after hijack
    // for SSE streams (where onResponse does not fire).
    (request as FastifyRequest & { [REQUEST_COUNTED_KEY]?: boolean })[REQUEST_COUNTED_KEY] = true;
    inFlightHttp += 1;
    markActivity(`http_started:${path}`);
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

  app.get('/health/live', {
    schema: {
      security: [],
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    },
  }, async () => ({ ok: true }));

  // Reports readiness without forcing a NATS round-trip. Probing NATS here would
  // reconnect (and keep) the connection open, defeating idle sleep, so we only
  // report the current connection state. The worker reconnects lazily on the next
  // operation request regardless of what this returns.
  app.get('/health/ready', {
    schema: {
      security: [],
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, natsConnected: { type: 'boolean' } },
          required: ['ok', 'natsConnected'],
        },
      },
    },
  }, async () => ({ ok: true, natsConnected: session !== null }));

  app.post('/v1/whisper-align/operations', {
    schema: {
      body: jsonSchema(whisperOperationCreateSchema),
      response: { 202: jsonSchema(publicOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = whisperOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid request body',
        issues: parsed.error.issues,
      };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'whisper_align',
      opKey: buildWhisperOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await orchestrator.enqueueOrReuse(requestOp);
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toPublicOperation(op);
  });

  app.post('/v1/pdf-layout/operations', {
    schema: {
      body: jsonSchema(pdfOperationCreateSchema),
      response: { 202: jsonSchema(publicOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = pdfOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid request body',
        issues: parsed.error.issues,
      };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'pdf_layout',
      opKey: buildPdfOperationKey(parsed.data),
      payload: {
        documentId: parsed.data.documentId,
        namespace: parsed.data.namespace,
        documentObjectKey: parsed.data.documentObjectKey,
      },
    };
    await ensureOrphanedOpRecovery();
    const op = await orchestrator.enqueueOrReuse(requestOp);
    reply.code(202);
    return toPublicOperation(op);
  });

  app.post('/v1/pdf-layout/resolve', {
    schema: {
      body: jsonSchema(pdfResolveSchema),
      response: {
        200: jsonSchema(pdfLayoutResolutionSchema),
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = pdfResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const artifactKey = parsedPdfArtifactKey({
      documentId: parsed.data.documentId,
      namespace: parsed.data.namespace,
      prefix: s3Prefix,
    });
    const hasArtifact = await (options.routeDeps?.artifactExists ?? storage.objectExists)(artifactKey);
    const opKey = buildPdfOperationKey(parsed.data);
    const index = await operationStateStore.getOpIndex?.(opKey);
    const operation = index?.opId ? await operationStateStore.getOpState(index.opId) : null;
    return {
      artifact: hasArtifact ? { objectKey: artifactKey } : null,
      operation: operation ? toPublicOperation(operation) : null,
    };
  });

  app.get('/v1/operations/:opId', {
    schema: {
      params: jsonSchema(operationParamsSchema),
      response: { 200: jsonSchema(publicOperationSchema), 400: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = operationParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid op id' };
    }

    const state = await getOpState(params.data.opId);
    if (!state) {
      reply.code(404);
      return { error: 'Operation not found' };
    }

    return toPublicOperation(state);
  });

  app.get('/v1/operations/:opId/events', {
    schema: {
      params: jsonSchema(operationParamsSchema),
      querystring: jsonSchema(operationEventsQuerySchema),
      response: {
        200: { type: 'string', description: 'Server-sent PublicOperationEvent stream' },
        400: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const params = operationParamsSchema.safeParse(request.params);
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
    markActivity('sse_started');
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    // Tell the browser EventSource to back off before reconnecting. If this stream
    // is torn down because the worker went idle (NATS dropped), we don't want the
    // client to reconnect immediately and re-wake the container.
    reply.raw.write(encodeSseFrame({ retry: OP_EVENTS_RECONNECT_HINT_MS }));

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let keepalive: NodeJS.Timeout | null = null;

    const writeSnapshot = (snapshot: StreamedOperationState, eventId: number): void => {
      if (closed || reply.raw.writableEnded) return;
      const frameEvent: PublicOperationEvent<WhisperAlignJobResult | PdfLayoutJobResult> = {
        eventId,
        snapshot: toPublicOperation(snapshot),
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
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      activeSse = Math.max(0, activeSse - 1);
      markActivity('sse_closed');
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

      keepalive = setInterval(() => {
        if (closed || reply.raw.writableEnded) return;
        reply.raw.write(': keepalive\n\n');
      }, OP_EVENTS_KEEPALIVE_MS);

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
            // A real event is progress: refresh the idle window so an actively
            // streaming op keeps the worker awake. A silent stream does not.
            markActivity('sse_event');
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

  const jobHandlers = createJobHandlers({
    storage,
    whisperTimeoutMs,
    pdfTimeoutMs,
    pdfHardCapMs,
  });

  const workerLoops = createWorkerLoopController({
    orchestrator,
    handlers: jobHandlers,
    logger: app.log,
    jobConcurrency,
    pdfAttempts,
    whisperCodec: whisperJobCodec,
    pdfCodec: layoutJobCodec,
    isOwnerActive: (owner) => session === owner,
    isStopping: () => stopping,
    markActivity,
    onInFlightJobsChanged: (delta) => {
      inFlightJobs = Math.max(0, inFlightJobs + delta);
    },
  });

  const close = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    if (orphanSweepTimer) {
      clearInterval(orphanSweepTimer);
      orphanSweepTimer = null;
    }
    await app.close();
    await workerLoops.stop();
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

  const registerSignalHandlers = (): void => {
    process.once('SIGINT', () => {
      void close().finally(() => process.exit(0));
    });

    process.once('SIGTERM', () => {
      void close().finally(() => process.exit(0));
    });
  };

  return {
    app,
    host,
    port,
    async start(startOptions) {
      if (startOptions?.registerSignalHandlers) {
        registerSignalHandlers();
      }
      await app.listen({ host, port });
      app.log.info({ host, port }, 'compute worker listening');
    },
    close,
  };
}

export async function startComputeWorkerFromEnv(): Promise<void> {
  const runtime = await createComputeWorkerApp();
  await runtime.start({ registerSignalHandlers: true });
}
