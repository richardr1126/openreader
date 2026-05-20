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
  type WorkerJobStatusResponse,
  type WorkerJobTiming,
} from '@openreader/compute-core/contracts';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const JOBS_STREAM_NAME = 'compute_jobs';
const WHISPER_JOBS_SUBJECT = 'jobs.whisper';
const LAYOUT_JOBS_SUBJECT = 'jobs.layout';
const WHISPER_CONSUMER_NAME = 'compute_whisper';
const LAYOUT_CONSUMER_NAME = 'compute_layout';
const JOB_STATES_BUCKET = 'job_states';
const JOB_STATES_TTL_MS = 24 * 60 * 60 * 1000;
const PULL_EXPIRES_MS = 1000;
const LOOP_ERROR_BACKOFF_MS = 500;
const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_NAMESPACE_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

interface QueuedJob<TPayload> {
  jobId: string;
  queuedAt: number;
  payload: TPayload;
}

interface StoredJobState<Result> extends WorkerJobStatusResponse<Result> {
  timestamp: number;
  startedAt?: number;
  updatedAt: number;
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

async function putState<Result>(
  kv: KV,
  codec: JsonCodec<StoredJobState<Result>>,
  jobId: string,
  state: StoredJobState<Result>,
): Promise<void> {
  await kv.put(jobId, codec.encode(state));
}

async function getState<Result>(
  kv: KV,
  codec: JsonCodec<StoredJobState<Result>>,
  jobId: string,
): Promise<StoredJobState<Result> | null> {
  const entry = await kv.get(jobId);
  if (!entry || entry.operation !== 'PUT') return null;
  return codec.decode(entry.value);
}

async function ensureJetStreamResources(
  jsm: JetStreamManager,
  whisperTimeoutMs: number,
  pdfTimeoutMs: number,
  attempts: number,
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

  const ensureConsumer = async (name: string, subject: string, ackWaitMs: number): Promise<void> => {
    const config = {
      durable_name: name,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      replay_policy: ReplayPolicy.Instant,
      filter_subject: subject,
      ack_wait: nanos(Math.max(ackWaitMs, 1_000)),
      max_deliver: attempts,
    };

    try {
      await jsm.consumers.add(JOBS_STREAM_NAME, config);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      await jsm.consumers.update(JOBS_STREAM_NAME, name, {
        filter_subject: subject,
        ack_wait: nanos(Math.max(ackWaitMs, 1_000)),
        max_deliver: attempts,
      });
    }
  };

  await Promise.all([
    ensureConsumer(WHISPER_CONSUMER_NAME, WHISPER_JOBS_SUBJECT, whisperTimeoutMs + 15_000),
    ensureConsumer(LAYOUT_CONSUMER_NAME, LAYOUT_JOBS_SUBJECT, pdfTimeoutMs + 15_000),
  ]);
}

async function createWorkerLoop<TPayload, TResult>(input: {
  consumer: Consumer;
  kv: KV;
  stateCodec: JsonCodec<StoredJobState<TResult>>;
  jobCodec: JsonCodec<QueuedJob<TPayload>>;
  run: (payload: TPayload, queueWaitMs: number) => Promise<TResult>;
  maxAttempts: number;
  logLabel: string;
  shouldStop: () => boolean;
  log: {
    error: (obj: Record<string, unknown>, msg: string) => void;
    info: (obj: Record<string, unknown>, msg: string) => void;
  };
}): Promise<void> {
  while (!input.shouldStop()) {
    let msg: JsMsg | null = null;
    try {
      msg = await input.consumer.next({ expires: PULL_EXPIRES_MS });
    } catch (error) {
      if (input.shouldStop()) return;
      input.log.error({ error: toErrorMessage(error), worker: input.logLabel }, 'worker pull failed');
      await new Promise((resolve) => setTimeout(resolve, LOOP_ERROR_BACKOFF_MS));
      continue;
    }

    if (!msg) continue;

    let decoded: QueuedJob<TPayload> | null = null;
    try {
      const job = input.jobCodec.decode(msg.data);
      decoded = job;
      const startedAt = Date.now();
      const queueWaitMs = safeDurationMs(job.queuedAt, startedAt);

      await putState(input.kv, input.stateCodec, job.jobId, {
        status: 'running',
        timestamp: job.queuedAt,
        startedAt,
        updatedAt: startedAt,
        ...(typeof queueWaitMs === 'number' ? { timing: { queueWaitMs } } : {}),
      });

      const result = await input.run(job.payload, queueWaitMs ?? 0);
      const resultTiming = result && typeof result === 'object' && 'timing' in result
        ? (result as { timing?: WorkerJobTiming }).timing
        : undefined;

      await putState(input.kv, input.stateCodec, job.jobId, {
        status: 'succeeded',
        timestamp: job.queuedAt,
        startedAt,
        updatedAt: Date.now(),
        result,
        ...(resultTiming ? { timing: resultTiming } : {}),
      });

      msg.ack();
      input.log.info({ worker: input.logLabel, jobId: job.jobId, timing: resultTiming }, 'job succeeded');
    } catch (error) {
      const message = toErrorMessage(error);
      const deliveryCount = msg.info.deliveryCount;
      const hasRetriesLeft = deliveryCount < input.maxAttempts;

      if (decoded?.jobId) {
        const now = Date.now();
        const queueWaitMs = safeDurationMs(decoded.queuedAt, now);
        const state: StoredJobState<TResult> = hasRetriesLeft
          ? {
            status: 'running',
            timestamp: decoded.queuedAt,
            updatedAt: now,
            ...(typeof queueWaitMs === 'number' ? { timing: { queueWaitMs } } : {}),
          }
          : {
            status: 'failed',
            timestamp: decoded.queuedAt,
            updatedAt: now,
            error: { message },
            ...(typeof queueWaitMs === 'number' ? { timing: { queueWaitMs } } : {}),
          };

        await putState(input.kv, input.stateCodec, decoded.jobId, state).catch((stateError) => {
          input.log.error({
            worker: input.logLabel,
            jobId: decoded?.jobId,
            error: toErrorMessage(stateError),
          }, 'failed to persist failed state');
        });
      }

      if (hasRetriesLeft) {
        msg.nak();
        input.log.error({
          worker: input.logLabel,
          jobId: decoded?.jobId,
          error: message,
          deliveryCount,
          maxAttempts: input.maxAttempts,
        }, 'job failed, nacked for retry');
      } else {
        msg.term(message);
        input.log.error({
          worker: input.logLabel,
          jobId: decoded?.jobId,
          error: message,
          deliveryCount,
          maxAttempts: input.maxAttempts,
        }, 'job failed, max attempts reached');
      }
    }
  }
}

async function main(): Promise<void> {
  const port = readIntEnv('COMPUTE_WORKER_PORT', 8081);
  const host = process.env.COMPUTE_WORKER_HOST?.trim() || '0.0.0.0';
  const workerToken = requireEnv('COMPUTE_WORKER_TOKEN');
  const natsUrl = requireEnv('NATS_URL');

  const whisperConcurrency = readIntEnv('COMPUTE_WHISPER_CONCURRENCY', 1);
  const pdfConcurrency = readIntEnv('COMPUTE_PDF_CONCURRENCY', 2);
  const whisperTimeoutMs = readIntEnv('COMPUTE_WHISPER_TIMEOUT_MS', 30_000);
  const pdfTimeoutMs = readIntEnv('COMPUTE_PDF_TIMEOUT_MS', 90_000);
  const attempts = readIntEnv('COMPUTE_JOB_ATTEMPTS', 2);
  const prewarmModels = parseBoolEnv('COMPUTE_PREWARM_MODELS', true);
  const jobsStreamMaxBytes = readIntEnv('COMPUTE_JOBS_STREAM_MAX_BYTES', 256 * 1024 * 1024);
  const jobStatesMaxBytes = readIntEnv('COMPUTE_JOB_STATES_MAX_BYTES', 64 * 1024 * 1024);

  const connectOpts: any = { servers: natsUrl };
  const natsCreds = process.env.NATS_CREDS?.trim();
  const natsCredsFile = process.env.NATS_CREDS_FILE?.trim();

  if (natsCreds) {
    console.log('[compute-worker] Connecting to NATS using credentials string from NATS_CREDS');
    connectOpts.authenticator = credsAuthenticator(new TextEncoder().encode(natsCreds));
  } else if (natsCredsFile) {
    console.log(`[compute-worker] Connecting to NATS using credentials file: ${natsCredsFile}`);
    const { readFileSync } = require('fs');
    const credsData = readFileSync(natsCredsFile);
    connectOpts.authenticator = credsAuthenticator(credsData);
  }

  const nc: NatsConnection = await connect(connectOpts);
  const js: JetStreamClient = jetstream(nc);
  const jsm: JetStreamManager = await jetstreamManager(nc);

  await ensureJetStreamResources(jsm, whisperTimeoutMs, pdfTimeoutMs, attempts, jobsStreamMaxBytes);

  const kv = await new Kvm(js).create(JOB_STATES_BUCKET, {
    history: 1,
    ttl: JOB_STATES_TTL_MS,
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

  const whisperStateCodec = createJsonCodec<StoredJobState<WhisperAlignJobResult>>();
  const layoutStateCodec = createJsonCodec<StoredJobState<PdfLayoutJobResult>>();
  const whisperJobCodec = createJsonCodec<QueuedJob<WhisperAlignJobRequest>>();
  const layoutJobCodec = createJsonCodec<QueuedJob<PdfLayoutJobRequest>>();

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

  app.post('/align/whisper/jobs', async (request, reply) => {
    const parsed = alignSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid request body',
        issues: parsed.error.issues,
      };
    }

    const jobId = crypto.randomUUID();
    const queuedAt = Date.now();

    await putState(kv, whisperStateCodec, jobId, {
      status: 'queued',
      timestamp: queuedAt,
      updatedAt: queuedAt,
    });

    await js.publish(WHISPER_JOBS_SUBJECT, whisperJobCodec.encode({
      jobId,
      queuedAt,
      payload: parsed.data,
    }));

    reply.code(202);
    return { jobId };
  });

  app.get('/align/whisper/jobs/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string().trim().min(1) }).safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid job id' };
    }

    const state = await getState(kv, whisperStateCodec, params.data.jobId);
    if (!state) {
      reply.code(404);
      return { error: 'Job not found' };
    }

    const response: WorkerJobStatusResponse<WhisperAlignJobResult> = {
      status: state.status,
      ...(state.result ? { result: state.result } : {}),
      ...(state.error ? { error: state.error } : {}),
      ...(state.timing ? { timing: state.timing } : {}),
    };

    return response;
  });

  app.post('/layout/pdf/jobs', async (request, reply) => {
    const parsed = layoutSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid request body',
        issues: parsed.error.issues,
      };
    }

    const jobId = crypto.randomUUID();
    const queuedAt = Date.now();

    await putState(kv, layoutStateCodec, jobId, {
      status: 'queued',
      timestamp: queuedAt,
      updatedAt: queuedAt,
    });

    await js.publish(LAYOUT_JOBS_SUBJECT, layoutJobCodec.encode({
      jobId,
      queuedAt,
      payload: parsed.data,
    }));

    reply.code(202);
    return { jobId };
  });

  app.get('/layout/pdf/jobs/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string().trim().min(1) }).safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid job id' };
    }

    const state = await getState(kv, layoutStateCodec, params.data.jobId);
    if (!state) {
      reply.code(404);
      return { error: 'Job not found' };
    }

    const response: WorkerJobStatusResponse<PdfLayoutJobResult> = {
      status: state.status,
      ...(state.result ? { result: state.result } : {}),
      ...(state.error ? { error: state.error } : {}),
      ...(state.timing ? { timing: state.timing } : {}),
    };

    return response;
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
  ): Promise<PdfLayoutJobResult> => {
    const parsed = layoutSchema.parse(payload);

    const s3FetchStartedAt = Date.now();
    const pdfBytes = await readObjectByKey(parsed.documentObjectKey);
    const s3FetchMs = Date.now() - s3FetchStartedAt;

    const computeStartedAt = Date.now();
    const result = await withTimeout(
      runPdfLayoutFromPdfBuffer({
        documentId: parsed.documentId,
        pdfBytes,
      }),
      pdfTimeoutMs,
      'pdf layout job',
    );

    const computeMs = Date.now() - computeStartedAt;
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

  const workerLoops: Promise<void>[] = [];

  for (let i = 0; i < whisperConcurrency; i += 1) {
    workerLoops.push(createWorkerLoop({
      consumer: whisperConsumer,
      kv,
      stateCodec: whisperStateCodec,
      jobCodec: whisperJobCodec,
      run: runWhisper,
      maxAttempts: attempts,
      logLabel: `whisper-${i + 1}`,
      shouldStop: () => stopping,
      log: app.log,
    }));
  }

  for (let i = 0; i < pdfConcurrency; i += 1) {
    workerLoops.push(createWorkerLoop({
      consumer: layoutConsumer,
      kv,
      stateCodec: layoutStateCodec,
      jobCodec: layoutJobCodec,
      run: runLayout,
      maxAttempts: attempts,
      logLabel: `layout-${i + 1}`,
      shouldStop: () => stopping,
      log: app.log,
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
