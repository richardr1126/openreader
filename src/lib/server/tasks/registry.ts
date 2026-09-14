import type { TaskRegistry } from './types';
import { reapOrphanedBlobs } from './handlers/reap-orphaned-blobs';
import { cleanupTempUploads } from './handlers/cleanup-temp-uploads';
import { expireExportArtifacts } from './handlers/expire-export-artifacts';
import { pruneComputeLimits } from './handlers/prune-compute-limits';

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
    description: 'Remove temporary upload objects past their TTL.',
    defaultIntervalMs: 60 * 60 * 1000,
    maxRunMs: 45_000,
    run: cleanupTempUploads,
  },
  'expire-export-artifacts': {
    name: 'Clean up expired exports',
    description: 'Remove completed account and audiobook exports after their retention window.',
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
};
