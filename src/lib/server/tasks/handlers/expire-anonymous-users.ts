import { getRuntimeConfig } from '@/lib/server/admin/settings';
import { deleteIdleAnonymousUser, listIdleAnonymousUserIds } from '@/lib/server/admin/users';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';
import type { TaskContext, TaskResult } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 25;
// Leave room for the last account's storage cleanup under the engine limit.
const DEADLINE_HEADROOM_MS = 10_000;

/** Delete guest accounts, with their documents and storage, after the configured idle period. */
export async function expireAnonymousUsers(context: TaskContext): Promise<TaskResult> {
  const { anonymousUserIdleDays } = await getRuntimeConfig();
  const idleBefore = new Date(Date.now() - anonymousUserIdleDays * DAY_MS);
  let deleted = 0;
  let failed = 0;
  const attempted = new Set<string>();

  while (Date.now() < context.deadlineAt - DEADLINE_HEADROOM_MS && !context.signal.aborted) {
    const ids = (await listIdleAnonymousUserIds(idleBefore, BATCH + attempted.size))
      .filter((id) => !attempted.has(id))
      .slice(0, BATCH);
    if (ids.length === 0) {
      return { summary: `Deleted ${deleted} idle guest account(s)`, deleted, failed };
    }
    for (const id of ids) {
      if (Date.now() >= context.deadlineAt - DEADLINE_HEADROOM_MS || context.signal.aborted) break;
      attempted.add(id);
      try {
        if (await deleteIdleAnonymousUser(id, idleBefore)) deleted += 1;
      } catch (error) {
        failed += 1;
        logDegraded(serverLogger, {
          event: 'tasks.expire_anonymous_users.delete_failed',
          msg: 'Failed to delete an idle guest account',
          step: 'delete_idle_anonymous_user',
          context: { userIdHash: hashForLog(id) },
          error,
        });
      }
    }
  }
  return { summary: `Deleted ${deleted} idle guest account(s); more remain`, deleted, failed };
}
