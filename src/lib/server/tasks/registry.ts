import type { TaskRegistry } from './types';
import { reapOrphanedBlobs } from './handlers/reap-orphaned-blobs';
import { cleanupTempUploads } from './handlers/cleanup-temp-uploads';
import { expireExportArtifacts } from './handlers/expire-export-artifacts';
import { pruneJobEvents } from './handlers/prune-job-events';
import { pruneTtsUsage } from './handlers/prune-tts-usage';

/**
 * The catalog of scheduled tasks. Each key is the stable task id stored in the
 * `scheduled_tasks` table; renaming a key orphans its row (the engine ignores
 * rows with no matching definition).
 */
export const TASK_REGISTRY: TaskRegistry = {
  'reap-orphaned-blobs': {
    name: 'Reap orphaned document blobs',
    description: 'Delete content-addressed document blobs that no longer have any owner.',
    defaultIntervalMs: 6 * 60 * 60 * 1000,
    maxRunMs: 45_000,
    run: reapOrphanedBlobs,
  },
  'cleanup-temp-uploads': {
    name: 'Clean up expired uploads',
    description: 'Remove temporary upload objects past their TTL.',
    defaultIntervalMs: 60 * 60 * 1000,
    maxRunMs: 45_000,
    run: cleanupTempUploads,
  },
  'expire-export-artifacts': {
    name: 'Expire export artifacts',
    description: 'Delete completed account/audiobook export artifacts older than the retention window.',
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    maxRunMs: 45_000,
    run: expireExportArtifacts,
  },
  'prune-job-events': {
    name: 'Prune job event ledger',
    description: 'Delete rate-limit job events older than the retention window.',
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    maxRunMs: 30_000,
    run: pruneJobEvents,
  },
  'prune-tts-usage': {
    name: 'Prune TTS usage counters',
    description: 'Delete TTS usage rows (user_tts_chars) older than 30 days.',
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    maxRunMs: 30_000,
    run: pruneTtsUsage,
  },
};
