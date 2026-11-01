import type { TaskRegistry } from './types';
import { pruneComputeLimits } from './handlers/prune-compute-limits';
import { enqueueMaintenanceTask } from './enqueue-maintenance';

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
    run: (context) => enqueueMaintenanceTask('reap-orphaned-blobs', context),
  },
  'cleanup-temp-uploads': {
    name: 'Clean up expired files',
    description: 'Remove unfinished uploads and DOCX conversions after a day, and account export ZIPs after seven days. Audiobooks are kept until audio is cleared.',
    defaultIntervalMs: 60 * 60 * 1000,
    maxRunMs: 45_000,
    run: (context) => enqueueMaintenanceTask('cleanup-temp-uploads', context),
  },
  'prune-compute-limits': {
    name: 'Clean up compute history',
    description: 'Reconcile expired compute leases and remove old limit counters and events.',
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    maxRunMs: 30_000,
    run: pruneComputeLimits,
  },
  'retry-storage-cleanups': {
    name: 'Finish pending deletions',
    description: 'Finish account deletions interrupted by a restart or failed cleanup, then delete audio and exports left by deleted documents and accounts, including the delayed second pass.',
    defaultIntervalMs: 15 * 60 * 1000,
    maxRunMs: 45_000,
    run: (context) => enqueueMaintenanceTask('retry-storage-cleanups', context),
  },
  'expire-anonymous-users': {
    name: 'Delete idle guest accounts',
    description: 'Delete guest accounts and their data after the idle period set under Guest sessions.',
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    defaultEnabled: false,
    maxRunMs: 45_000,
    run: (context) => enqueueMaintenanceTask('expire-anonymous-users', context),
  },
};
