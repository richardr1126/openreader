import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import {
  credsAuthenticator,
  type ConnectionOptions,
} from '@nats-io/transport-node';
import {
  ensureComputeModels,
} from '../inference/runtime';
import {
  getComputeTimeoutConfig,
  getComputeOpStaleMs,
  getAvailableCpuCores,
  getOnnxThreadsPerJob,
  buildLoggerConfig,
  normalizeNatsReplicas,
  readBoolEnv,
  readPositiveIntEnv,
  requireEnv,
} from '../infrastructure/config';
import { OperationOrchestrator } from '../operations';
import type {
  AccountExportJobRequest,
  AccountExportJobResult,
  DocumentPreviewJobRequest,
  DocumentPreviewJobResult,
  DocumentConversionJobRequest,
  DocumentConversionJobResult,
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  TtsPlaybackPlanJobRequest,
  TtsPlaybackPlanJobResult,
  TtsPlaybackExportArtifactRequest,
  TtsPlaybackExportArtifactResult,
  TtsPlaybackJobRequest,
  TtsPlaybackJobResult,
} from '../operations/contracts';
import {
  JetStreamOperationEventStream,
  JetStreamOperationQueue,
  JetStreamOperationStateStore,
} from '../infrastructure/nats-adapters';
import { createJsonCodec } from '../infrastructure/json-codec';
import { createOperationReconciler } from '../operations/reconciliation';
import {
  createArtifactStorage,
  createS3ClientFromEnv,
  normalizeS3Prefix,
  type ArtifactStorage,
} from '../infrastructure/storage';
import { createTtsPlaybackStorage } from '../playback/storage';
import { createJobHandlers } from '../jobs/handlers';
import { createWorkerLoopController, type QueuedJob } from '../jobs/worker-loop';
import { createNatsSessionManager } from '../infrastructure/nats-session';
import {
  ACCOUNT_EXPORT_JOBS_SUBJECT,
  EVENTS_STREAM_NAME,
  DOCUMENT_PREVIEW_JOBS_SUBJECT,
  DOCUMENT_CONVERSION_JOBS_SUBJECT,
  LAYOUT_JOBS_SUBJECT,
  NATS_API_TIMEOUT_MS,
  TTS_PLAYBACK_PLAN_JOBS_SUBJECT,
  TTS_PLAYBACK_EXPORT_JOBS_SUBJECT,
  TTS_PLAYBACK_JOBS_SUBJECT,
} from '../infrastructure/nats';
import { registerHttpHooks } from './http-hooks';
import {
  registerComputeWorkerRoutes,
  type ComputeWorkerRouteDeps,
} from './routes';
import {
  apiErrorResponseSchema,
  artifactReferenceSchema,
  jsonSchema,
  operationErrorSchema,
  parsedPdfDocumentSchema,
  pdfLayoutProgressSchema,
  pdfLayoutResolutionSchema,
  computeOperationEventSchema,
  computeOperationSchema,
  accountExportArtifactMetadataSchema,
  accountExportProgressSchema,
  accountExportResolutionSchema,
  documentPreviewArtifactMetadataSchema,
  documentConversionArtifactMetadataSchema,
  documentConversionProgressSchema,
  documentConversionResolutionSchema,
  documentPreviewResolutionSchema,
  ttsPlaybackExportArtifactMetadataSchema,
  ttsPlaybackExportProgressSchema,
  ttsPlaybackExportArtifactResolutionSchema,
  ttsSentenceAlignmentSchema,
} from './schemas';
import { resolveStorageTransport } from '@openreader/runtime-config/storage-transport';

// Disconnect from NATS after this much continuous idle so the worker stops
// generating outbound traffic (pull polling + keepalive PINGs) and Railway can
// put it to sleep. Reconnect happens lazily on the next inbound request.
const IDLE_DISCONNECT_MS = 120_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;
const IDLE_STATUS_LOG_INTERVAL_MS = 60_000;
const ORPHAN_SWEEP_INTERVAL_MS = 15_000;

export type { ComputeWorkerRouteDeps } from './routes';

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

export async function createComputeWorkerApp(options: CreateComputeWorkerAppOptions = {}): Promise<ComputeWorkerApp> {
  const port = options.port ?? readPositiveIntEnv('PORT', 8081);
  const host = options.host ?? (process.env.COMPUTE_WORKER_HOST?.trim() || '0.0.0.0');
  const workerToken = options.workerToken ?? requireEnv('COMPUTE_WORKER_TOKEN');
  const disableWorkers = options.disableWorkers ?? false;
  // Test/control-plane instances intentionally disable all object access. A
  // real worker validates the shared browser/server storage contract at startup.
  if (!disableWorkers) resolveStorageTransport(process.env);
  const natsUrl = requireEnv('NATS_URL');
  const timeoutConfig = getComputeTimeoutConfig();

  const jobConcurrency = readPositiveIntEnv('COMPUTE_JOB_CONCURRENCY', 1);
  const whisperTimeoutMs = timeoutConfig.whisperTimeoutMs;
  const pdfTimeoutMs = timeoutConfig.pdfTimeoutMs;
  const pdfHardCapMs = timeoutConfig.pdfHardCapMs;
  const ttsPlaybackSegmentTimeoutMs = timeoutConfig.ttsPlaybackSegmentTimeoutMs;
  const pdfAttempts = readPositiveIntEnv('COMPUTE_PDF_JOB_ATTEMPTS', 1);
  const prewarmModels = readBoolEnv('COMPUTE_PREWARM_MODELS', false);
  const jobsStreamMaxBytes = readPositiveIntEnv('COMPUTE_JOBS_STREAM_MAX_BYTES', 256 * 1024 * 1024);
  const eventsStreamMaxBytes = readPositiveIntEnv('COMPUTE_EVENTS_STREAM_MAX_BYTES', 128 * 1024 * 1024);
  const jobStatesMaxBytes = readPositiveIntEnv('COMPUTE_JOB_STATES_MAX_BYTES', 64 * 1024 * 1024);
  const natsReplicas = normalizeNatsReplicas(readPositiveIntEnv('COMPUTE_NATS_REPLICAS', 1));
  const opStaleMs = getComputeOpStaleMs();

  const connectOpts: ConnectionOptions = { servers: natsUrl };
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

  let stopping = false;
  let inFlightHttp = 0;
  let activeSse = 0;
  let inFlightJobs = 0;
  let lastActivityAt = Date.now();
  let lastActivityReason = "startup";
  const markActivity = (reason: string): void => {
    lastActivityAt = Date.now();
    lastActivityReason = reason;
  };
  let sessionManager!: ReturnType<typeof createNatsSessionManager>;
  const ensureConnected = () => sessionManager.ensureConnected();

  const s3Prefix = normalizeS3Prefix(process.env.S3_PREFIX);
  const storageDisabled = async (): Promise<never> => {
    throw new Error('S3 access is disabled for this worker app instance');
  };
  const storage: ArtifactStorage = disableWorkers
    ? {
      readObject: storageDisabled,
      objectExists: storageDisabled,
      deleteObject: storageDisabled,
      listPrefix: storageDisabled,
      putObject: storageDisabled,
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
          TtsPlaybackExportProgress: jsonSchema(ttsPlaybackExportProgressSchema),
          DocumentConversionProgress: jsonSchema(documentConversionProgressSchema),
          AccountExportProgress: jsonSchema(accountExportProgressSchema),
          TtsPlaybackExportArtifact: jsonSchema(ttsPlaybackExportArtifactMetadataSchema),
          AccountExportArtifact: jsonSchema(accountExportArtifactMetadataSchema),
          DocumentPreviewArtifact: jsonSchema(documentPreviewArtifactMetadataSchema),
          DocumentConversionArtifact: jsonSchema(documentConversionArtifactMetadataSchema),
          ComputeOperation: jsonSchema(computeOperationSchema),
          ComputeOperationEvent: jsonSchema(computeOperationEventSchema),
          PdfLayoutResolution: jsonSchema(pdfLayoutResolutionSchema),
          TtsPlaybackExportArtifactResolution: jsonSchema(ttsPlaybackExportArtifactResolutionSchema),
          DocumentPreviewResolution: jsonSchema(documentPreviewResolutionSchema),
          DocumentConversionResolution: jsonSchema(documentConversionResolutionSchema),
          AccountExportResolution: jsonSchema(accountExportResolutionSchema),
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

  const layoutJobCodec = createJsonCodec<QueuedJob<PdfLayoutJobRequest>>();
  const ttsPlaybackJobCodec = createJsonCodec<QueuedJob<TtsPlaybackJobRequest>>();
  const ttsPlaybackPlanJobCodec = createJsonCodec<QueuedJob<TtsPlaybackPlanJobRequest>>();
  const ttsPlaybackExportJobCodec = createJsonCodec<QueuedJob<TtsPlaybackExportArtifactRequest>>();
  const documentPreviewJobCodec = createJsonCodec<QueuedJob<DocumentPreviewJobRequest>>();
  const documentConversionJobCodec = createJsonCodec<QueuedJob<DocumentConversionJobRequest>>();
  const accountExportJobCodec = createJsonCodec<QueuedJob<AccountExportJobRequest>>();

  const defaultOperationStateStore = new JetStreamOperationStateStore<PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult | TtsPlaybackExportArtifactResult | DocumentPreviewJobResult | DocumentConversionJobResult | AccountExportJobResult>({
    getKv: async () => (await ensureConnected()).kv,
  });

  const defaultOperationEventStream = new JetStreamOperationEventStream<PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult | TtsPlaybackExportArtifactResult | DocumentPreviewJobResult | DocumentConversionJobResult | AccountExportJobResult>({
    getJs: async () => (await ensureConnected()).js,
    getJsm: async () => (await ensureConnected()).jsm,
    eventsStreamName: EVENTS_STREAM_NAME,
  });
  const playbackStorage = createTtsPlaybackStorage({
    getKv: async () => (await ensureConnected()).kv,
    storage,
    s3Prefix,
  });

  const operationQueue = new JetStreamOperationQueue({
    getJs: async () => (await ensureConnected()).js,
    layoutSubject: LAYOUT_JOBS_SUBJECT,
    ttsPlaybackSubject: TTS_PLAYBACK_JOBS_SUBJECT,
    ttsPlaybackPlanSubject: TTS_PLAYBACK_PLAN_JOBS_SUBJECT,
    ttsPlaybackExportSubject: TTS_PLAYBACK_EXPORT_JOBS_SUBJECT,
    documentPreviewSubject: DOCUMENT_PREVIEW_JOBS_SUBJECT,
    documentConversionSubject: DOCUMENT_CONVERSION_JOBS_SUBJECT,
    accountExportSubject: ACCOUNT_EXPORT_JOBS_SUBJECT,
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
  const reconciler = createOperationReconciler({
    stateStore: operationStateStore,
    orchestrator,
    whisperTimeoutMs,
    pdfTimeoutMs,
    opStaleMs,
    getGeneration: () => options.routeDeps ? 0 : sessionManager.getGeneration(),
    logger: app.log,
  });
  const ensureOrphanedOpRecovery = () => reconciler.run();
  const getOpState = (opId: string) => reconciler.getOpState(opId);

  const { releaseHttp } = registerHttpHooks({
    app,
    workerToken,
    markActivity,
    onInFlightHttpChanged: (delta) => {
      inFlightHttp = Math.max(0, inFlightHttp + delta);
    },
  });

  registerComputeWorkerRoutes({
    app,
    deps: {
      orchestrator,
      operationStateStore,
      operationEventStream,
      artifactExists: options.routeDeps?.artifactExists ?? storage.objectExists,
    },
    storage,
    playbackStorage: options.routeDeps ? undefined : playbackStorage,
    s3Prefix,
    ensureOrphanedOpRecovery,
    getOpState,
    getNatsConnected: () => sessionManager.isConnected(),
    releaseHttp,
    markActivity,
    onActiveSseChanged: (delta) => {
      activeSse = Math.max(0, activeSse + delta);
    },
  });

  const jobHandlers = createJobHandlers({
    storage,
    playbackStorage,
    pdfTimeoutMs,
    pdfHardCapMs,
    ttsPlaybackSegmentTimeoutMs,
    s3Prefix,
  });

  const workerLoops = createWorkerLoopController({
    orchestrator,
    handlers: jobHandlers,
    logger: app.log,
    jobConcurrency,
    pdfAttempts,
    pdfCodec: layoutJobCodec,
    ttsPlaybackCodec: ttsPlaybackJobCodec,
    ttsPlaybackPlanCodec: ttsPlaybackPlanJobCodec,
    ttsPlaybackExportCodec: ttsPlaybackExportJobCodec,
    documentPreviewCodec: documentPreviewJobCodec,
    documentConversionCodec: documentConversionJobCodec,
    accountExportCodec: accountExportJobCodec,
    isOwnerActive: (owner) => sessionManager.isOwnerActive(owner),
    isStopping: () => stopping,
    markActivity,
    onInFlightJobsChanged: (delta) => {
      inFlightJobs = Math.max(0, inFlightJobs + delta);
    },
  });

  sessionManager = createNatsSessionManager({
    connectOptions: connectOpts,
    logger: app.log,
    whisperTimeoutMs,
    pdfTimeoutMs,
    pdfAttempts,
    jobsStreamMaxBytes,
    eventsStreamMaxBytes,
    jobStatesMaxBytes,
    natsReplicas,
    isStopping: () => stopping,
    getActivity: () => ({
      activeSse,
      inFlightHttp,
      inFlightJobs,
      lastActivityAt,
      lastActivityReason,
    }),
    markActivity,
    startWorkers: (session) => {
      if (disableWorkers) return;
      workerLoops.start(session, {
        pdfLayout: session.layoutConsumer,
        ttsPlayback: session.ttsPlaybackConsumer,
        ttsPlaybackPlan: session.ttsPlaybackPlanConsumer,
        ttsPlaybackExport: session.ttsPlaybackExportConsumer,
        documentPreview: session.documentPreviewConsumer,
        documentConversion: session.documentConversionConsumer,
        accountExport: session.accountExportConsumer,
      });
    },
    stopWorkers: () => workerLoops.stop(),
    runReconciliation: () => reconciler.run({ force: true }),
  });

  const close = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await sessionManager.close();
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
