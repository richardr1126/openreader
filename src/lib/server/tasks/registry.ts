import type { TaskRegistry } from './types';
import { reapOrphanedBlobs } from './handlers/reap-orphaned-blobs';
import { cleanupTempUploads } from './handlers/cleanup-temp-uploads';
import { expireExportArtifacts } from './handlers/expire-export-artifacts';
import { pruneComputeLimits } from './handlers/prune-compute-limits';
import { retryStorageCleanups } from './handlers/retry-storage-cleanups';
import { expireAnonymousUsers } from './handlers/expire-anonymous-users';
import { scanOrphanedStorage } from './handlers/scan-orphaned-storage';

/**
 * The catalog of scheduled tasks. Each key is the stable task id stored in the
 * `scheduled_tasks` table; renaming a key orphans its row (the engine ignores
 * rows with no matching definition).
 */
export const TASK_REGISTRY: TaskRegistry = {
  'reap-orphaned-blobs': {
    name: 'Clean up unowned documents',
    description: 'Remove document files and generated artifacts that no longer have an owner.',
    defaultIntervalMs: 6 * 60 * 60 * 1000,
    maxRunMs: 45_000,
    run: reapOrphanedBlobs,
  },
  'cleanup-temp-uploads': {
    name: 'Clean up expired uploads',
    description: 'Remove temporary uploads and DOCX conversions past their TTL.',
    defaultIntervalMs: 60 * 60 * 1000,
    maxRunMs: 45_000,
    run: cleanupTempUploads,
  },
  'expire-export-artifacts': {
    name: 'Clean up expired exports',
    description: 'Remove temporary account export ZIPs after seven days. Audiobooks are kept until audio is cleared.',
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    maxRunMs: 45_000,
    run: expireExportArtifacts,
  },
  'prune-compute-limits': {
    name: 'Clean up compute history',
    description: 'Reconcile expired compute leases and remove old limit counters and events.',
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    maxRunMs: 30_000,
    run: pruneComputeLimits,
  },
  'retry-storage-cleanups': {
    name: 'Retry storage cleanup',
    description: 'Delete audio and exports left by deleted documents and accounts, including retries and the delayed second pass.',
    defaultIntervalMs: 15 * 60 * 1000,
    maxRunMs: 45_000,
    run: retryStorageCleanups,
  },
  'expire-anonymous-users': {
    name: 'Delete idle guest accounts',
    description: 'Delete guest accounts and their data after the idle period set under Guest sessions.',
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    defaultEnabled: false,
    maxRunMs: 45_000,
    run: expireAnonymousUsers,
  },
  // ONE-TIME: disables itself after a complete pass. Remove with its handler.
  'scan-orphaned-storage': {
    name: 'Find leftover storage',
    description: 'One-time scan that queues cleanup for audio and exports left by earlier deletes.',
    defaultIntervalMs: 10 * 60 * 1000,
    maxRunMs: 45_000,
    run: scanOrphanedStorage,
  },
};
