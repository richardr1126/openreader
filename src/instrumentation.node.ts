import { startTaskScheduler } from '@/lib/server/tasks/scheduler';

if (!process.env.VERCEL) {
  startTaskScheduler();
}
