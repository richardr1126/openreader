import { createHash } from 'node:crypto';
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
import { Kvm, type KV } from '@nats-io/kv';
import {
  ensureComputeModels,
  runPdfLayoutFromPdfBuffer,
  runWhisperAlignmentFromAudioBuffer,
} from '@openreader/compute-core/local-runtime';
import {
  type PdfLayoutJobRequest,
  type PdfLayoutJobResult,
  type WhisperAlignJobRequest,
  type WhisperAlignJobResult,
  type WorkerJobErrorShape,
  type WorkerJobState,
  type WorkerJobTiming,
  type WorkerOperationKind,
  type WorkerOperationRequest,
  type WorkerOperationState,
  type PdfLayoutProgress,
} from '@openreader/compute-core/contracts';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const JOBS_STREAM_NAME = 'compute_jobs';
const WHISPER_JOBS_SUBJECT = 'jobs.whisper';
const LAYOUT_JOBS_SUBJECT = 'jobs.layout';
const WHISPER_CONSUMER_NAME = 'compute_whisper';
const LAYOUT_CONSUMER_NAME = 'compute_layout';
const COMPUTE_STATE_BUCKET = 'compute_state';
const COMPUTE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const PULL_EXPIRES_MS = 1000;
const LOOP_ERROR_BACKOFF_MS = 500;
const SSE_POLL_INTERVAL_MS = 400;
const RUNNING_HEARTBEAT_MS = 5000;
const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const WHISPER_MAX_DELIVER = 1;

interface QueuedJob<TPayload> {
  jobId: string;
  opId: string;
  opKey: string;
  kind: WorkerOperationKind;
  queuedAt: number;
  payload: TPayload;
}

interface StoredJobState<Result> {
  jobId: string;
  opId: string;
  opKey: string;
  kind: WorkerOperationKind;
  status: WorkerJobState;
  timestamp: number;
  startedAt?: number;
  updatedAt: number;
  result?: Result;
  error?: WorkerJobErrorShape;
  timing?: WorkerJobTiming;
  progress?: PdfLayoutProgress;
}

interface OpIndexEntry {
  opId: string;
}

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

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function buildLoggerConfig(): boolean | Record<string, unknown> {
  const format = (process.env.COMPUTE_LOG_FORMAT?.trim().toLowerCase() || 'pretty');
  if (format === 'json') return true;
  return {
    level: process.env.COMPUTE_LOG_LEVEL?.trim() || 'info',
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

function isAlreadyExistsError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('already in use') || message.includes('already exists');
}

function isCasConflictError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('wrong last sequence') || message.includes('key exists') || message.includes('wrong last');
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

function isTerminalStatus(status: WorkerJobState): boolean {
  return status === 'succeeded' || status === 'failed';
}

function hashOpKey(opKey: string): string {
  return createHash('sha256').update(opKey).digest('hex');
}

function opIndexKvKey(opKey: string): string {
  return `op_index.${hashOpKey(opKey)}`;
}

function opStateKvKey(opId: string): string {
  return `op_state.${opId}`;
}

function jobStateKvKey(jobId: string): string {
  return `job_state.${jobId}`;
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
  maxBytes: number,
): Promise<void> {
  const streamConfig = {
    name: JOBS_STREAM_NAME,
    subjects: [WHISPER_JOBS_SUBJECT, LAYOUT_JOBS_SUBJECT],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_bytes: maxBytes,
  };

  try {
    await jsm.streams.add(streamConfig);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    await jsm.streams.update(JOBS_STREAM_NAME, {
      subjects: [WHISPER_JOBS_SUBJECT, LAYOUT_JOBS_SUBJECT],
      max_bytes: maxBytes,
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

  const whisperConcurrency = readIntEnv('COMPUTE_WHISPER_CONCURRENCY', 1);
  const pdfConcurrency = readIntEnv('COMPUTE_PDF_CONCURRENCY', 2);
  const whisperTimeoutMs = readIntEnv('COMPUTE_WHISPER_TIMEOUT_MS', 30_000);
  const pdfTimeoutMs = readIntEnv('COMPUTE_PDF_TIMEOUT_MS', 90_000);
  const pdfAttempts = readIntEnv('COMPUTE_PDF_JOB_ATTEMPTS', 2);
  const prewarmModels = parseBoolEnv('COMPUTE_PREWARM_MODELS', true);
  const jobsStreamMaxBytes = readIntEnv('COMPUTE_JOBS_STREAM_MAX_BYTES', 256 * 1024 * 1024);
  const jobStatesMaxBytes = readIntEnv('COMPUTE_JOB_STATES_MAX_BYTES', 64 * 1024 * 1024);
  const opStaleMs = readIntEnv(
    'COMPUTE_OP_STALE_MS',
    Math.max(30 * 60_000, Math.max(whisperTimeoutMs, pdfTimeoutMs) * 4),
  );

  const connectOpts: any = { servers: natsUrl };
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

  const nc: NatsConnection = await connect(connectOpts);
  const js: JetStreamClient = jetstream(nc);
  const jsm: JetStreamManager = await jetstreamManager(nc);

  await ensureJetStreamResources(jsm, whisperTimeoutMs, pdfTimeoutMs, pdfAttempts, jobsStreamMaxBytes);

  const kv = await new Kvm(js).create(COMPUTE_STATE_BUCKET, {
    history: 1,
    ttl: COMPUTE_STATE_TTL_MS,
    max_bytes: jobStatesMaxBytes,
  });

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

  const app = Fastify({ logger: buildLoggerConfig() });

  const opIndexCodec = createJsonCodec<OpIndexEntry>();
  const opStateCodec = createJsonCodec<WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult>>();
  const whisperJobCodec = createJsonCodec<QueuedJob<WhisperAlignJobRequest>>();
  const layoutJobCodec = createJsonCodec<QueuedJob<PdfLayoutJobRequest>>();
  const jobStateCodec = createJsonCodec<StoredJobState<WhisperAlignJobResult | PdfLayoutJobResult>>();

  const putOpState = async (state: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult>): Promise<void> => {
    await kv.put(opStateKvKey(state.opId), opStateCodec.encode(state));
  };

  const getOpState = async (opId: string): Promise<WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult> | null> => {
    const entry = await kv.get(opStateKvKey(opId));
    if (!entry || entry.operation !== 'PUT') return null;
    return opStateCodec.decode(entry.value);
  };

  const putJobState = async (state: StoredJobState<WhisperAlignJobResult | PdfLayoutJobResult>): Promise<void> => {
    await kv.put(jobStateKvKey(state.jobId), jobStateCodec.encode(state));
  };

  const publishQueuedJob = async (
    op: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult>,
    payload: WhisperAlignJobRequest | PdfLayoutJobRequest,
  ): Promise<void> => {
    if (op.kind === 'whisper_align') {
      await js.publish(WHISPER_JOBS_SUBJECT, whisperJobCodec.encode({
        jobId: op.jobId,
        opId: op.opId,
        opKey: op.opKey,
        kind: 'whisper_align',
        queuedAt: op.queuedAt,
        payload: payload as WhisperAlignJobRequest,
      }));
      return;
    }

    await js.publish(LAYOUT_JOBS_SUBJECT, layoutJobCodec.encode({
      jobId: op.jobId,
      opId: op.opId,
      opKey: op.opKey,
      kind: 'pdf_layout',
      queuedAt: op.queuedAt,
      payload: payload as PdfLayoutJobRequest,
    }));
  };

  const enqueueOrReuseOperation = async (
    req: WorkerOperationRequest,
  ): Promise<WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult>> => {
    const opKey = req.opKey.trim();
    const indexKey = opIndexKvKey(opKey);

    for (let attemptNo = 0; attemptNo < 10; attemptNo += 1) {
      const indexEntry = await kv.get(indexKey);
      if (indexEntry && indexEntry.operation === 'PUT') {
        const pointer = opIndexCodec.decode(indexEntry.value);
        const current = await getOpState(pointer.opId);

        if (!current) {
          await sleep(25);
          continue;
        }

        if (current && current.kind === req.kind) {
          const ageMs = Date.now() - current.updatedAt;
          if (current.status === 'succeeded') return current;
          if ((current.status === 'queued' || current.status === 'running') && ageMs <= opStaleMs) {
            return current;
          }
        }

        const now = Date.now();
        const replacement: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult> = {
          opId: crypto.randomUUID(),
          opKey,
          kind: req.kind,
          jobId: crypto.randomUUID(),
          status: 'queued',
          queuedAt: now,
          updatedAt: now,
        };

        try {
          await kv.update(indexKey, opIndexCodec.encode({ opId: replacement.opId }), indexEntry.revision);
        } catch (error) {
          if (isCasConflictError(error)) continue;
          throw error;
        }

        await putOpState(replacement);
        await putJobState({
          jobId: replacement.jobId,
          opId: replacement.opId,
          opKey: replacement.opKey,
          kind: replacement.kind,
          status: 'queued',
          timestamp: now,
          updatedAt: now,
        });

        try {
          await publishQueuedJob(replacement, req.payload);
          return replacement;
        } catch (error) {
          const failed: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult> = {
            ...replacement,
            status: 'failed',
            updatedAt: Date.now(),
            error: { message: toErrorMessage(error) },
          };
          await putOpState(failed);
          await putJobState({
            jobId: replacement.jobId,
            opId: replacement.opId,
            opKey: replacement.opKey,
            kind: replacement.kind,
            status: 'failed',
            timestamp: replacement.queuedAt,
            updatedAt: failed.updatedAt,
            error: failed.error,
          });
          return failed;
        }
      }

      const now = Date.now();
      const created: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult> = {
        opId: crypto.randomUUID(),
        opKey,
        kind: req.kind,
        jobId: crypto.randomUUID(),
        status: 'queued',
        queuedAt: now,
        updatedAt: now,
      };

      try {
        await kv.create(indexKey, opIndexCodec.encode({ opId: created.opId }));
      } catch (error) {
        if (isCasConflictError(error)) continue;
        throw error;
      }

      await putOpState(created);
      await putJobState({
        jobId: created.jobId,
        opId: created.opId,
        opKey: created.opKey,
        kind: created.kind,
        status: 'queued',
        timestamp: now,
        updatedAt: now,
      });

      try {
        await publishQueuedJob(created, req.payload);
        return created;
      } catch (error) {
        const failed: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult> = {
          ...created,
          status: 'failed',
          updatedAt: Date.now(),
          error: { message: toErrorMessage(error) },
        };
        await putOpState(failed);
        await putJobState({
          jobId: created.jobId,
          opId: created.opId,
          opKey: created.opKey,
          kind: created.kind,
          status: 'failed',
          timestamp: created.queuedAt,
          updatedAt: failed.updatedAt,
          error: failed.error,
        });
        return failed;
      }
    }

    throw new Error('Unable to reserve operation after repeated CAS conflicts');
  };

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (path === '/health/live' || path === '/health/ready') return;
    if (!isAuthed(request, workerToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    return;
  });

  app.get('/health/live', async () => ({ ok: true }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await nc.flush();
      return { ok: true };
    } catch (error) {
      reply.code(503);
      return {
        ok: false,
        error: toErrorMessage(error),
      };
    }
  });

  app.post('/ops', async (request, reply) => {
    const parsed = operationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid request body',
        issues: parsed.error.issues,
      };
    }

    const op = await enqueueOrReuseOperation(parsed.data as WorkerOperationRequest);
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

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');

    const writeSnapshot = (snapshot: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult>): void => {
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };

    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    let current = initial;
    writeSnapshot(current);
    let signature = JSON.stringify(current);

    while (!closed && !isTerminalStatus(current.status)) {
      await sleep(SSE_POLL_INTERVAL_MS);
      const next = await getOpState(params.data.opId);
      if (!next) break;
      const nextSignature = JSON.stringify(next);
      if (nextSignature !== signature) {
        current = next;
        signature = nextSignature;
        writeSnapshot(current);
      }
    }

    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  });

  const whisperConsumer = await js.consumers.get(JOBS_STREAM_NAME, WHISPER_CONSUMER_NAME);
  const layoutConsumer = await js.consumers.get(JOBS_STREAM_NAME, LAYOUT_CONSUMER_NAME);

  let stopping = false;

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
    const result = await withTimeout(
      runPdfLayoutFromPdfBuffer({
        documentId: parsed.documentId,
        pdfBytes,
        onPageParsed: async ({ pageNumber, totalPages }) => {
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
      pdfTimeoutMs,
      'pdf layout job',
    );

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

      const runningState: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult> = {
        opId: decoded.opId,
        opKey: decoded.opKey,
        kind: decoded.kind,
        jobId: decoded.jobId,
        status: 'running',
        queuedAt: decoded.queuedAt,
        startedAt,
        updatedAt: startedAt,
        ...(typeof queueWaitMs === 'number' ? { timing: { queueWaitMs } } : {}),
        ...(latestProgress ? { progress: latestProgress } : {}),
      };

      await putOpState(runningState);
      await putJobState({
        jobId: decoded.jobId,
        opId: decoded.opId,
        opKey: decoded.opKey,
        kind: decoded.kind,
        status: 'running',
        timestamp: decoded.queuedAt,
        startedAt,
        updatedAt: startedAt,
        ...(typeof queueWaitMs === 'number' ? { timing: { queueWaitMs } } : {}),
        ...(latestProgress ? { progress: latestProgress } : {}),
      });

      const persistRunningState = async (updatedAt: number): Promise<void> => {
        const runningOpState: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult> = {
          opId: decoded!.opId,
          opKey: decoded!.opKey,
          kind: decoded!.kind,
          jobId: decoded!.jobId,
          status: 'running',
          queuedAt: decoded!.queuedAt,
          startedAt,
          updatedAt,
          ...(typeof queueWaitMs === 'number' ? { timing: { queueWaitMs } } : {}),
          ...(latestProgress ? { progress: latestProgress } : {}),
        };

        await putOpState(runningOpState);
        await putJobState({
          jobId: decoded!.jobId,
          opId: decoded!.opId,
          opKey: decoded!.opKey,
          kind: decoded!.kind,
          status: 'running',
          timestamp: decoded!.queuedAt,
          startedAt,
          updatedAt,
          ...(typeof queueWaitMs === 'number' ? { timing: { queueWaitMs } } : {}),
          ...(latestProgress ? { progress: latestProgress } : {}),
        });
      };

      heartbeat = setInterval(() => {
        const now = Date.now();
        void persistRunningState(now).catch((stateError) => {
          app.log.error({
            worker: input.workerLabel,
            opId: decoded?.opId,
            jobId: decoded?.jobId,
            error: toErrorMessage(stateError),
          }, 'failed to persist running heartbeat state');
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

      const succeededState: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult> = {
        opId: decoded.opId,
        opKey: decoded.opKey,
        kind: decoded.kind,
        jobId: decoded.jobId,
        status: 'succeeded',
        queuedAt: decoded.queuedAt,
        startedAt,
        updatedAt: now,
        result: result as WhisperAlignJobResult | PdfLayoutJobResult,
        ...(resultTiming ? { timing: resultTiming } : {}),
        ...(latestProgress ? { progress: latestProgress } : {}),
      };

      await putOpState(succeededState);
      await putJobState({
        jobId: decoded.jobId,
        opId: decoded.opId,
        opKey: decoded.opKey,
        kind: decoded.kind,
        status: 'succeeded',
        timestamp: decoded.queuedAt,
        startedAt,
        updatedAt: now,
        result: result as WhisperAlignJobResult | PdfLayoutJobResult,
        ...(resultTiming ? { timing: resultTiming } : {}),
        ...(latestProgress ? { progress: latestProgress } : {}),
      });

      input.msg.ack();
      app.log.info({
        worker: input.workerLabel,
        opId: decoded.opId,
        jobId: decoded.jobId,
        resultRef: extractResultRef(decoded.kind, result),
        timing: resultTiming,
      }, 'job succeeded');
    } catch (error) {
      const message = toErrorMessage(error);
      const deliveryCount = input.msg.info.deliveryCount;
      const isWhisperAlign = decoded?.kind === 'whisper_align';
      const maxAttempts = isWhisperAlign ? WHISPER_MAX_DELIVER : pdfAttempts;
      const hasRetriesLeft = !isWhisperAlign && deliveryCount < maxAttempts;

      if (decoded) {
        const now = Date.now();
        const queueWaitMs = safeDurationMs(decoded.queuedAt, now);

        const status: WorkerJobState = hasRetriesLeft ? 'running' : 'failed';
        const opState: WorkerOperationState<WhisperAlignJobResult | PdfLayoutJobResult> = {
          opId: decoded.opId,
          opKey: decoded.opKey,
          kind: decoded.kind,
          jobId: decoded.jobId,
          status,
          queuedAt: decoded.queuedAt,
          updatedAt: now,
          ...(status === 'failed' ? { error: { message } } : {}),
          ...(typeof queueWaitMs === 'number' ? { timing: { queueWaitMs } } : {}),
          ...(latestProgress ? { progress: latestProgress } : {}),
        };

        await putOpState(opState).catch((stateError) => {
          app.log.error({
            worker: input.workerLabel,
            opId: decoded?.opId,
            jobId: decoded?.jobId,
            error: toErrorMessage(stateError),
          }, 'failed to persist operation state');
        });

        await putJobState({
          jobId: decoded.jobId,
          opId: decoded.opId,
          opKey: decoded.opKey,
          kind: decoded.kind,
          status,
          timestamp: decoded.queuedAt,
          updatedAt: now,
          ...(status === 'failed' ? { error: { message } } : {}),
          ...(typeof queueWaitMs === 'number' ? { timing: { queueWaitMs } } : {}),
          ...(latestProgress ? { progress: latestProgress } : {}),
        }).catch((stateError) => {
          app.log.error({
            worker: input.workerLabel,
            opId: decoded?.opId,
            jobId: decoded?.jobId,
            error: toErrorMessage(stateError),
          }, 'failed to persist job state');
        });
      }

      if (hasRetriesLeft) {
        input.msg.nak();
        app.log.error({
          worker: input.workerLabel,
          opId: decoded?.opId,
          jobId: decoded?.jobId,
          error: message,
          deliveryCount,
          maxAttempts,
        }, 'job failed, nacked for retry');
      } else {
        input.msg.term(message);
        app.log.error({
          worker: input.workerLabel,
          opId: decoded?.opId,
          jobId: decoded?.jobId,
          error: message,
          deliveryCount,
          maxAttempts,
          retrySuppressed: isWhisperAlign ? 'whisper_align' : undefined,
        }, 'job failed, max attempts reached');
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async function createWorkerLoop<TPayload, TResult>(input: {
    consumer: Consumer;
    codec: JsonCodec<QueuedJob<TPayload>>;
    run: (
      payload: TPayload,
      queueWaitMs: number,
      hooks?: { onProgress?: (progress: PdfLayoutProgress) => Promise<void> },
    ) => Promise<TResult>;
    workerLabel: string;
  }): Promise<void> {
    while (!stopping) {
      let msg: JsMsg | null = null;
      try {
        msg = await input.consumer.next({ expires: PULL_EXPIRES_MS });
      } catch (error) {
        if (stopping) return;
        app.log.error({ error: toErrorMessage(error), worker: input.workerLabel }, 'worker pull failed');
        await sleep(LOOP_ERROR_BACKOFF_MS);
        continue;
      }

      if (!msg) continue;
      await processMessage({
        msg,
        codec: input.codec,
        run: input.run,
        workerLabel: input.workerLabel,
      });
    }
  }

  const workerLoops: Promise<void>[] = [];

  for (let i = 0; i < whisperConcurrency; i += 1) {
    workerLoops.push(createWorkerLoop({
      consumer: whisperConsumer,
      codec: whisperJobCodec,
      run: runWhisper,
      workerLabel: `whisper-${i + 1}`,
    }));
  }

  for (let i = 0; i < pdfConcurrency; i += 1) {
    workerLoops.push(createWorkerLoop({
      consumer: layoutConsumer,
      codec: layoutJobCodec,
      run: runLayout,
      workerLabel: `layout-${i + 1}`,
    }));
  }

  const close = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await Promise.allSettled(workerLoops);
    await nc.drain();
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
