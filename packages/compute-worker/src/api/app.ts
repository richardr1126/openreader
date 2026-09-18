import Fastify, { LogController, type FastifyInstance } from 'fastify';
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
  configureComputeJobConcurrency,
  buildLoggerConfig,
  normalizeNatsReplicas,
  readBoolEnv,
  readPositiveIntEnv,
  requireEnv,
} from '../infrastructure/config';
import {
  getTtsCredentialBrokerConfig,
  requireTtsSegmentTextHashSecret,
} from '../infrastructure/credential-broker-config';
import { OperationOrchestrator } from '../operations/service';
import type {
  AccountExportJobRequest,
  AccountExportJobResult,
  EmailDeliveryJobRequest,
  EmailDeliveryJobResult,
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
import { fetchComputeLimitPolicy } from '../jobs/compute-limit-policy-broker';
import { notifyComputeAdmissionTerminal } from '../jobs/compute-limit-broker';
import { cloneComputeLimitPolicyDocument } from '@openreader/runtime-config/compute-limits';
import { ProviderCapacityCoordinator } from '../jobs/provider-capacity';
import { createNatsSessionManager } from '../infrastructure/nats-session';
import {
  ACCOUNT_EXPORT_JOBS_SUBJECT,
  EMAIL_DELIVERY_JOBS_SUBJECT,
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
  if (!disableWorkers) {
    resolveStorageTransport(process.env);
    getTtsCredentialBrokerConfig();
    requireTtsSegmentTextHashSecret();
  }
  const natsUrl = requireEnv('NATS_URL');
  const timeoutConfig = getComputeTimeoutConfig();

  let computePolicy = cloneComputeLimitPolicyDocument();
  let computePolicyLastFetchedAt = 0;
  if (!disableWorkers) {
    try {
      computePolicy = await fetchComputeLimitPolicy();
      computePolicyLastFetchedAt = Date.now();
    } catch (error) {
      computePolicy.worker.maxExecutingPerWorker = 1;
      for (const resource of Object.keys(computePolicy.worker.resources)) {
        computePolicy.worker.resources[resource as keyof typeof computePolicy.worker.resources] = 1;
      }
      for (const action of Object.values(computePolicy.actions)) {
        if (action.execution) action.execution.maxConcurrentPerWorker = 1;
      }
      console.error('[compute-worker] Initial compute policy fetch failed; using conservative limits until refresh', error);
    }
  }
  const jobConcurrency = computePolicy.worker.maxExecutingPerWorker;
  configureComputeJobConcurrency(jobConcurrency);
  let computePolicyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
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
    logController: new LogController({ disableRequestLogging: true }),
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
  const emailDeliveryJobCodec = createJsonCodec<QueuedJob<EmailDeliveryJobRequest>>();

  const defaultOperationStateStore = new JetStreamOperationStateStore<PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult | TtsPlaybackExportArtifactResult | DocumentPreviewJobResult | DocumentConversionJobResult | AccountExportJobResult | EmailDeliveryJobResult>({
    getKv: async () => (await ensureConnected()).kv,
  });

  const defaultOperationEventStream = new JetStreamOperationEventStream<PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult | TtsPlaybackExportArtifactResult | DocumentPreviewJobResult | DocumentConversionJobResult | AccountExportJobResult | EmailDeliveryJobResult>({
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
    emailDeliverySubject: EMAIL_DELIVERY_JOBS_SUBJECT,
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

  const providerCapacity = new ProviderCapacityCoordinator(
    () => computePolicy,
    async () => (await ensureConnected()).kv,
    app.log,
  );
  const jobHandlers = createJobHandlers({
    storage,
    playbackStorage,
    pdfTimeoutMs,
    pdfHardCapMs,
    ttsPlaybackSegmentTimeoutMs,
    s3Prefix,
    logger: app.log,
    acquireProviderCapacity: (input) => providerCapacity.acquire(input),
    getProviderMaxConcurrent: (providerRef) => providerCapacity.configuredMaxConcurrent(providerRef),
    coolDownProviderCapacity: (providerRef, retryAfterSeconds) => (
      providerCapacity.coolDown(providerRef, retryAfterSeconds)
    ),
  });

  const workerLoops = createWorkerLoopController({
    orchestrator,
    handlers: jobHandlers,
    logger: app.log,
    getComputePolicy: () => computePolicy,
    pdfAttempts,
    pdfCodec: layoutJobCodec,
    ttsPlaybackCodec: ttsPlaybackJobCodec,
    ttsPlaybackPlanCodec: ttsPlaybackPlanJobCodec,
    ttsPlaybackExportCodec: ttsPlaybackExportJobCodec,
    documentPreviewCodec: documentPreviewJobCodec,
    documentConversionCodec: documentConversionJobCodec,
    accountExportCodec: accountExportJobCodec,
    emailDeliveryCodec: emailDeliveryJobCodec,
    isOwnerActive: (owner) => sessionManager.isOwnerActive(owner),
    isStopping: () => stopping,
    markActivity,
    onInFlightJobsChanged: (delta) => {
      inFlightJobs = Math.max(0, inFlightJobs + delta);
    },
    onOperationTerminal: notifyComputeAdmissionTerminal,
  });

  let computePolicyRefresh: Promise<void> | null = null;
  const refreshComputePolicy = (): Promise<void> => {
    if (computePolicyRefresh) return computePolicyRefresh;
    computePolicyRefresh = fetchComputeLimitPolicy().then((nextPolicy) => {
      computePolicy = nextPolicy;
      computePolicyLastFetchedAt = Date.now();
      configureComputeJobConcurrency(nextPolicy.worker.maxExecutingPerWorker);
      workerLoops.policyChanged();
    }).catch((error) => {
      app.log.error({ error: String(error) }, 'compute policy refresh failed');
    }).finally(() => {
      computePolicyRefresh = null;
    });
    return computePolicyRefresh;
  };

  const scheduleComputePolicyRefresh = (): void => {
    if (disableWorkers || stopping) return;
    computePolicyRefreshTimer = setTimeout(() => {
      // A disconnected worker has no active queue consumers. Broker traffic here
      // would prevent Railway from sleeping even though the worker is idle.
      if (!sessionManager.isConnected()) {
        scheduleComputePolicyRefresh();
        return;
      }
      void refreshComputePolicy().finally(scheduleComputePolicyRefresh);
    }, computePolicy.worker.policyRefreshSeconds * 1000);
  };
  scheduleComputePolicyRefresh();

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
    startWorkers: async (session) => {
      if (disableWorkers) return;
      if (Date.now() - computePolicyLastFetchedAt >= computePolicy.worker.policyRefreshSeconds * 1000) {
        await refreshComputePolicy();
      }
      workerLoops.start(session, {
        pdfLayout: session.layoutConsumer,
        ttsPlayback: session.ttsPlaybackConsumer,
        ttsPlaybackPlan: session.ttsPlaybackPlanConsumer,
        ttsPlaybackExport: session.ttsPlaybackExportConsumer,
        documentPreview: session.documentPreviewConsumer,
        documentConversion: session.documentConversionConsumer,
        accountExport: session.accountExportConsumer,
        emailDelivery: session.emailDeliveryConsumer,
      });
    },
    stopWorkers: () => workerLoops.stop(),
    runReconciliation: () => reconciler.run({ force: true }),
  });

  const close = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (computePolicyRefreshTimer) clearTimeout(computePolicyRefreshTimer);
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
