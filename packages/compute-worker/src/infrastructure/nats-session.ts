import type { Consumer, JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import { connect, type ConnectionOptions, type NatsConnection } from '@nats-io/transport-node';
import {
  COMPUTE_STATE_BUCKET,
  COMPUTE_STATE_TTL_MS,
  DOCUMENT_CONVERSION_CONSUMER_NAME,
  DOCUMENT_PREVIEW_CONSUMER_NAME,
  JOBS_STREAM_NAME,
  LAYOUT_CONSUMER_NAME,
  NATS_API_TIMEOUT_MS,
  TTS_PLAYBACK_CONSUMER_NAME,
  TTS_PLAYBACK_EXPORT_CONSUMER_NAME,
  TTS_PLAYBACK_PLAN_CONSUMER_NAME,
  ensureJetStreamResources,
} from './nats';

const IDLE_DISCONNECT_MS = 120_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;
const IDLE_STATUS_LOG_INTERVAL_MS = 60_000;
const ORPHAN_SWEEP_INTERVAL_MS = 15_000;

export interface NatsSession {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  kv: Awaited<ReturnType<Kvm['create']>>;
  layoutConsumer: Consumer;
  ttsPlaybackConsumer: Consumer;
  ttsPlaybackPlanConsumer: Consumer;
  ttsPlaybackExportConsumer: Consumer;
  documentPreviewConsumer: Consumer;
  documentConversionConsumer: Consumer;
}

interface NatsSessionLogger {
  info(data: unknown, message?: string): void;
  info(message: string): void;
  error(data: unknown, message?: string): void;
}

export interface NatsActivitySnapshot {
  activeSse: number;
  inFlightHttp: number;
  inFlightJobs: number;
  lastActivityAt: number;
  lastActivityReason: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function createNatsSessionManager(input: {
  connectOptions: ConnectionOptions;
  logger: NatsSessionLogger;
  whisperTimeoutMs: number;
  pdfTimeoutMs: number;
  pdfAttempts: number;
  jobsStreamMaxBytes: number;
  eventsStreamMaxBytes: number;
  jobStatesMaxBytes: number;
  natsReplicas: number;
  isStopping: () => boolean;
  getActivity: () => NatsActivitySnapshot;
  markActivity: (reason: string) => void;
  startWorkers: (session: NatsSession) => void;
  stopWorkers: () => Promise<void>;
  runReconciliation: () => Promise<void>;
}) {
  let session: NatsSession | null = null;
  let connecting: Promise<NatsSession> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let orphanSweepTimer: NodeJS.Timeout | null = null;
  let lastIdleStatusLogAt = 0;
  let generation = -1;

  const clearTimers = () => {
    if (idleTimer) clearInterval(idleTimer);
    if (orphanSweepTimer) clearInterval(orphanSweepTimer);
    idleTimer = null;
    orphanSweepTimer = null;
  };

  const disconnect = async (reason: string): Promise<void> => {
    const current = session;
    if (!current) return;
    const activity = input.getActivity();
    input.logger.info({
      reason,
      activeSse: activity.activeSse,
      inFlightHttp: activity.inFlightHttp,
      inFlightJobs: activity.inFlightJobs,
      idleForMs: Date.now() - activity.lastActivityAt,
    }, 'nats dropping connection');
    session = null;
    clearTimers();
    try {
      await current.nc.close();
    } catch {
      // Closing an already-closed session is harmless.
    }
    await input.stopWorkers();
    input.logger.info({ reason }, 'nats disconnected');
  };

  const startTimers = () => {
    if (!idleTimer) {
      idleTimer = setInterval(() => {
        if (!session || input.isStopping()) return;
        const activity = input.getActivity();
        const now = Date.now();
        const idleForMs = now - activity.lastActivityAt;
        if (now - lastIdleStatusLogAt >= IDLE_STATUS_LOG_INTERVAL_MS) {
          lastIdleStatusLogAt = now;
          input.logger.info({
            ...activity,
            idleForMs,
            disconnectEligible: activity.inFlightHttp === 0
              && activity.inFlightJobs === 0
              && idleForMs >= IDLE_DISCONNECT_MS,
          }, 'nats idle status');
        }
        if (activity.inFlightHttp > 0 || activity.inFlightJobs > 0 || idleForMs < IDLE_DISCONNECT_MS) return;
        void disconnect('idle');
      }, IDLE_CHECK_INTERVAL_MS);
      idleTimer.unref?.();
    }
    if (!orphanSweepTimer) {
      orphanSweepTimer = setInterval(() => {
        if (!session || input.isStopping()) return;
        void input.runReconciliation().catch((error) => {
          input.logger.error({ error: toErrorMessage(error) }, 'periodic orphaned operation recovery failed');
        });
      }, ORPHAN_SWEEP_INTERVAL_MS);
      orphanSweepTimer.unref?.();
    }
  };

  const ensureConnected = async (): Promise<NatsSession> => {
    if (session) return session;
    if (connecting) return connecting;
    connecting = (async () => {
      const nc = await connect(input.connectOptions);
      const js = jetstream(nc, { timeout: NATS_API_TIMEOUT_MS });
      const jsm = await jetstreamManager(nc, { timeout: NATS_API_TIMEOUT_MS });
      await ensureJetStreamResources({
        jsm,
        whisperTimeoutMs: input.whisperTimeoutMs,
        pdfTimeoutMs: input.pdfTimeoutMs,
        pdfAttempts: input.pdfAttempts,
        jobsMaxBytes: input.jobsStreamMaxBytes,
        eventsMaxBytes: input.eventsStreamMaxBytes,
        natsReplicas: input.natsReplicas,
      });
      const kv = await new Kvm(js).create(COMPUTE_STATE_BUCKET, {
        replicas: input.natsReplicas,
        history: 1,
        ttl: COMPUTE_STATE_TTL_MS,
        max_bytes: input.jobStatesMaxBytes,
      });
      const next: NatsSession = {
        nc,
        js,
        jsm,
        kv,
        layoutConsumer: await js.consumers.get(JOBS_STREAM_NAME, LAYOUT_CONSUMER_NAME),
        ttsPlaybackConsumer: await js.consumers.get(JOBS_STREAM_NAME, TTS_PLAYBACK_CONSUMER_NAME),
        ttsPlaybackPlanConsumer: await js.consumers.get(JOBS_STREAM_NAME, TTS_PLAYBACK_PLAN_CONSUMER_NAME),
        ttsPlaybackExportConsumer: await js.consumers.get(JOBS_STREAM_NAME, TTS_PLAYBACK_EXPORT_CONSUMER_NAME),
        documentPreviewConsumer: await js.consumers.get(JOBS_STREAM_NAME, DOCUMENT_PREVIEW_CONSUMER_NAME),
        documentConversionConsumer: await js.consumers.get(JOBS_STREAM_NAME, DOCUMENT_CONVERSION_CONSUMER_NAME),
      };
      session = next;
      generation += 1;
      input.markActivity('nats_connected');
      input.startWorkers(next);
      startTimers();
      void nc.closed().then(() => {
        if (session?.nc === nc) session = null;
      });
      input.logger.info('nats connected');
      return next;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  };

  return {
    ensureConnected,
    disconnect,
    isConnected: () => session !== null,
    isOwnerActive: (owner: object) => session === owner,
    getGeneration: () => generation,
    async close(): Promise<void> {
      clearTimers();
      await input.stopWorkers();
      const current = session;
      session = null;
      if (!current) return;
      try {
        await current.nc.drain();
      } catch {
        try {
          await current.nc.close();
        } catch {
          // Closing an already-closed session is harmless.
        }
      }
    },
  };
}
