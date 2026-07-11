import { startTaskScheduler } from '@/lib/server/tasks/scheduler';
import { resolveStorageTransport } from '../packages/bootstrap/src/storage-transport.mjs';

// Fail deployment startup on an ambiguous browser object transport instead of
// discovering it after a browser has started an upload or download.
resolveStorageTransport(process.env);

if (!process.env.VERCEL) {
  startTaskScheduler();
}
