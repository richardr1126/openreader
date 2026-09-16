import { startTaskScheduler } from '@/lib/server/tasks/scheduler';
import { resumePendingUserDeletions } from '@/lib/server/admin/users';
import { serverLogger } from '@/lib/server/logger';
import { resolveStorageTransport } from '@openreader/runtime-config/storage-transport';

// Fail deployment startup on an ambiguous browser object transport instead of
// discovering it after a browser has started an upload or download.
resolveStorageTransport(process.env);

if (!process.env.VERCEL) {
  startTaskScheduler();
  // Finish any user deletion that was durably requested but interrupted before
  // its storage + row cleanup completed. Fire-and-forget so a slow or failing
  // sweep never blocks startup; individual failures are retried next boot.
  void resumePendingUserDeletions().catch((error) => {
    serverLogger.error({ event: 'admin.user_delete.resume_sweep_failed', error }, 'Pending user deletion sweep failed');
  });
}
