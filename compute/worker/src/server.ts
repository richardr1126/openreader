import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { z } from 'zod';
import {
  ALIGN_QUEUE_NAME,
  PDF_LAYOUT_QUEUE_NAME,
  ensureComputeModels,
  runPdfLayoutFromPdfBuffer,
  runWhisperAlignmentFromAudioBuffer,
  type PdfLayoutJobRequest,
  type PdfLayoutJobResult,
  type WhisperAlignJobRequest,
  type WhisperAlignJobResult,
  type WorkerJobStatusResponse,
  type WorkerJobTiming,
} from '@openreader/compute-core';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

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

function parseRetryAfterSeconds(raw: string | undefined): number {
  const parsed = Number(raw ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) return 2;
  return Math.max(1, Math.floor(parsed));
}

function isAuthed(request: FastifyRequest, expectedToken: string): boolean {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  return token === expectedToken;
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

function mapJobState<Result>(job: Job): WorkerJobStatusResponse<Result> {
  const result = job.returnvalue as Result | undefined;
  const resultTiming = readResultTiming(result);
  const timing = buildJobTimingSnapshot(job, resultTiming);

  if (job.failedReason) {
    return {
      status: 'failed',
      error: {
        message: job.failedReason || 'Worker job failed',
      },
      ...(timing ? { timing } : {}),
    };
  }
  if (typeof job.returnvalue !== 'undefined' && job.finishedOn) {
    return {
      status: 'succeeded',
      result: job.returnvalue as Result,
      ...(timing ? { timing } : {}),
    };
  }

  if (job.processedOn) {
    return {
      status: 'running',
      ...(timing ? { timing } : {}),
    };
  }
  return {
    status: 'queued',
    ...(timing ? { timing } : {}),
  };
}

function readResultTiming<Result>(result: Result | undefined): WorkerJobTiming | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const maybe = result as { timing?: WorkerJobTiming };
  if (!maybe.timing || typeof maybe.timing !== 'object') return undefined;
  return maybe.timing;
}

function toSafeDurationMs(start: number | undefined, end: number | undefined): number | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, Math.floor((end as number) - (start as number)));
}

function buildJobTimingSnapshot(job: Job, base?: WorkerJobTiming): WorkerJobTiming | undefined {
  const now = Date.now();
  const timestamp = typeof job.timestamp === 'number' ? job.timestamp : undefined;
  const processedOn = typeof job.processedOn === 'number' ? job.processedOn : undefined;

  const timing: WorkerJobTiming = {
    ...(base ?? {}),
  };

  if (typeof timing.queueWaitMs !== 'number') {
    timing.queueWaitMs = processedOn
      ? toSafeDurationMs(timestamp, processedOn)
      : toSafeDurationMs(timestamp, now);
  }

  const hasAnyTiming = Object.values(timing).some((value) => typeof value === 'number' && Number.isFinite(value));
  return hasAnyTiming ? timing : undefined;
}

async function getQueueDepth(queue: Queue): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'active', 'prioritized', 'delayed');
  return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0);
}

async function main(): Promise<void> {
  const port = readIntEnv('COMPUTE_WORKER_PORT', 8081);
  const host = process.env.COMPUTE_WORKER_HOST?.trim() || '0.0.0.0';
  const workerToken = requireEnv('COMPUTE_WORKER_TOKEN');
  const redisUrl = requireEnv('REDIS_URL');
  const queueMaxDepth = readIntEnv('COMPUTE_QUEUE_MAX_DEPTH', 64);
  const retryAfterSec = parseRetryAfterSeconds(process.env.COMPUTE_QUEUE_RETRY_AFTER_SEC);

  const whisperConcurrency = readIntEnv('COMPUTE_WHISPER_CONCURRENCY', 1);
  const pdfConcurrency = readIntEnv('COMPUTE_PDF_CONCURRENCY', 2);
  const whisperTimeoutMs = readIntEnv('COMPUTE_WHISPER_TIMEOUT_MS', 30_000);
  const pdfTimeoutMs = readIntEnv('COMPUTE_PDF_TIMEOUT_MS', 90_000);
  const attempts = readIntEnv('COMPUTE_JOB_ATTEMPTS', 2);
  const prewarmModels = parseBoolEnv('COMPUTE_PREWARM_MODELS', true);

  const redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const queueDefaults: JobsOptions = {
    attempts,
    backoff: {
      type: 'exponential',
      delay: 500,
    },
    removeOnComplete: {
      age: 60 * 60,
      count: 1000,
    },
    removeOnFail: {
      age: 24 * 60 * 60,
      count: 5000,
    },
  };

  const alignQueue = new Queue<WhisperAlignJobRequest, WhisperAlignJobResult>(ALIGN_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: queueDefaults,
  });
  const layoutQueue = new Queue<PdfLayoutJobRequest, PdfLayoutJobResult>(PDF_LAYOUT_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: queueDefaults,
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

  const alignWorker = new Worker<WhisperAlignJobRequest, WhisperAlignJobResult>(
    ALIGN_QUEUE_NAME,
    async (job) => {
      const processingStartedAt = Date.now();
      const queueWaitMs = typeof job.timestamp === 'number'
        ? Math.max(0, processingStartedAt - job.timestamp)
        : undefined;
      const parsed = alignSchema.parse(job.data);
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
          ...(result.timing ?? {}),
          queueWaitMs,
          s3FetchMs,
          computeMs,
        },
      };
    },
    {
      connection: redis,
      concurrency: whisperConcurrency,
    },
  );

  const layoutWorker = new Worker<PdfLayoutJobRequest, PdfLayoutJobResult>(
    PDF_LAYOUT_QUEUE_NAME,
    async (job) => {
      const processingStartedAt = Date.now();
      const queueWaitMs = typeof job.timestamp === 'number'
        ? Math.max(0, processingStartedAt - job.timestamp)
        : undefined;
      const parsed = layoutSchema.parse(job.data);
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
      return {
        ...result,
        timing: {
          ...(result.timing ?? {}),
          queueWaitMs,
          s3FetchMs,
          computeMs,
        },
      };
    },
    {
      connection: redis,
      concurrency: pdfConcurrency,
    },
  );

  if (prewarmModels) {
    await ensureComputeModels();
  }

  const app = Fastify({
    logger: buildLoggerConfig(),
  });

  alignWorker.on('completed', (job, result) => {
    app.log.info({
      queue: ALIGN_QUEUE_NAME,
      jobId: job.id,
      timing: buildJobTimingSnapshot(job, readResultTiming(result)),
    }, 'whisper align job completed');
  });

  alignWorker.on('failed', (job, err) => {
    app.log.error({
      queue: ALIGN_QUEUE_NAME,
      jobId: job?.id,
      error: err.message,
      timing: job ? buildJobTimingSnapshot(job) : undefined,
    }, 'whisper align job failed');
  });

  layoutWorker.on('completed', (job, result) => {
    app.log.info({
      queue: PDF_LAYOUT_QUEUE_NAME,
      jobId: job.id,
      timing: buildJobTimingSnapshot(job, readResultTiming(result)),
    }, 'pdf layout job completed');
  });

  layoutWorker.on('failed', (job, err) => {
    app.log.error({
      queue: PDF_LAYOUT_QUEUE_NAME,
      jobId: job?.id,
      error: err.message,
      timing: job ? buildJobTimingSnapshot(job) : undefined,
    }, 'pdf layout job failed');
  });

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
      await redis.ping();
      return { ok: true };
    } catch (error) {
      reply.code(503);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const rejectIfSaturated = async (queue: Queue, reply: FastifyReply): Promise<boolean> => {
    const depth = await getQueueDepth(queue);
    if (depth < queueMaxDepth) return false;
    reply.header('Retry-After', String(retryAfterSec));
    reply.code(429).send({
      error: 'Queue is saturated',
      retryAfterSeconds: retryAfterSec,
      queueDepth: depth,
      queueMaxDepth,
    });
    return true;
  };

  app.post('/align/whisper/jobs', async (request, reply) => {
    const parsed = alignSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid request body',
        issues: parsed.error.issues,
      };
    }
    if (await rejectIfSaturated(alignQueue, reply)) return;

    const job = await alignQueue.add('align', parsed.data);
    reply.code(202);
    return { jobId: String(job.id) };
  });

  app.get('/align/whisper/jobs/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string().trim().min(1) }).safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid job id' };
    }
    const job = await alignQueue.getJob(params.data.jobId);
    if (!job) {
      reply.code(404);
      return { error: 'Job not found' };
    }
    return mapJobState<WhisperAlignJobResult>(job);
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
    if (await rejectIfSaturated(layoutQueue, reply)) return;

    const job = await layoutQueue.add('layout', parsed.data);
    reply.code(202);
    return { jobId: String(job.id) };
  });

  app.get('/layout/pdf/jobs/:jobId', async (request, reply) => {
    const params = z.object({ jobId: z.string().trim().min(1) }).safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid job id' };
    }
    const job = await layoutQueue.getJob(params.data.jobId);
    if (!job) {
      reply.code(404);
      return { error: 'Job not found' };
    }
    return mapJobState<PdfLayoutJobResult>(job);
  });

  const close = async (): Promise<void> => {
    await app.close();
    await Promise.allSettled([
      alignWorker.close(),
      layoutWorker.close(),
      alignQueue.close(),
      layoutQueue.close(),
      redis.quit(),
    ]);
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
