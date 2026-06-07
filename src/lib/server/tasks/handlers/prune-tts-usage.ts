import { rateLimiter } from '@/lib/server/rate-limit/rate-limiter';
import type { TaskResult } from '../types';

const RETENTION_DAYS = 30;

/** Delete TTS usage counter rows (user_tts_chars) older than the retention window. */
export async function pruneTtsUsage(): Promise<TaskResult> {
  await rateLimiter.cleanupOldRecords(RETENTION_DAYS);
  return { summary: `Pruned TTS usage older than ${RETENTION_DAYS}d` };
}
