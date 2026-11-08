import { eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { scheduledTasks } from '@openreader/database/schema';
import { getRuntimeConfig } from '@/lib/server/admin/settings';

/** Days an idle guest is kept, or null while nothing deletes idle guests. */
export async function getGuestRetentionDays(): Promise<number | null> {
  const [task] = await db.select({ enabled: scheduledTasks.enabled }).from(scheduledTasks)
    .where(eq(scheduledTasks.key, 'expire-anonymous-users')).limit(1);
  if (!task?.enabled) return null;
  const config = await getRuntimeConfig();
  return config.allowAnonymousSessions ? config.anonymousUserIdleDays : null;
}
