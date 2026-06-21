import {
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  type JetStreamManager,
} from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';
import { OP_EVENTS_SUBJECT_WILDCARD } from './nats-adapters';

export const JOBS_STREAM_NAME = 'compute_jobs';
export const LAYOUT_JOBS_SUBJECT = 'jobs.layout';
export const TTS_PLAYBACK_JOBS_SUBJECT = 'jobs.tts_playback';
export const LAYOUT_CONSUMER_NAME = 'compute_layout';
export const TTS_PLAYBACK_CONSUMER_NAME = 'compute_tts_playback';
export const EVENTS_STREAM_NAME = 'compute_events';
export const COMPUTE_STATE_BUCKET = 'compute_state';
export const COMPUTE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
export const NATS_API_TIMEOUT_MS = 60_000;

function isAlreadyExistsError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('already in use') || message.includes('already exists');
}

export async function ensureJetStreamResources(input: {
  jsm: JetStreamManager;
  whisperTimeoutMs: number;
  pdfTimeoutMs: number;
  pdfAttempts: number;
  jobsMaxBytes: number;
  eventsMaxBytes: number;
  natsReplicas: number;
}): Promise<void> {
  const streamConfig = {
    name: JOBS_STREAM_NAME,
    subjects: [LAYOUT_JOBS_SUBJECT, TTS_PLAYBACK_JOBS_SUBJECT],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_bytes: input.jobsMaxBytes,
    num_replicas: input.natsReplicas,
  };
  try {
    await input.jsm.streams.add(streamConfig);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    await input.jsm.streams.update(JOBS_STREAM_NAME, {
      subjects: streamConfig.subjects,
      max_bytes: input.jobsMaxBytes,
      num_replicas: input.natsReplicas,
    });
  }

  const eventsStreamConfig = {
    name: EVENTS_STREAM_NAME,
    subjects: [OP_EVENTS_SUBJECT_WILDCARD],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_bytes: input.eventsMaxBytes,
    max_age: nanos(COMPUTE_STATE_TTL_MS),
    num_replicas: input.natsReplicas,
  };
  try {
    await input.jsm.streams.add(eventsStreamConfig);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    await input.jsm.streams.update(EVENTS_STREAM_NAME, {
      subjects: eventsStreamConfig.subjects,
      max_bytes: input.eventsMaxBytes,
      max_age: eventsStreamConfig.max_age,
      num_replicas: input.natsReplicas,
    });
  }

  const ensureConsumer = async (name: string, subject: string, ackWaitMs: number, maxDeliver: number) => {
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
      await input.jsm.consumers.add(JOBS_STREAM_NAME, config);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      await input.jsm.consumers.update(JOBS_STREAM_NAME, name, {
        filter_subject: subject,
        ack_wait: config.ack_wait,
        max_deliver: maxDeliver,
      });
    }
  };

  await Promise.all([
    ensureConsumer(LAYOUT_CONSUMER_NAME, LAYOUT_JOBS_SUBJECT, input.pdfTimeoutMs + 15_000, input.pdfAttempts),
    ensureConsumer(TTS_PLAYBACK_CONSUMER_NAME, TTS_PLAYBACK_JOBS_SUBJECT, input.whisperTimeoutMs + 15_000, 1),
  ]);
}
