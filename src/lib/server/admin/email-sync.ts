import { eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

// We only need the `user` table here. Better Auth manages its own schema files;
// we import them lazily to avoid coupling this module to a single dialect.
function getUserTable() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite = require('@openreader/database/schema-auth-sqlite');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require('@openreader/database/schema-auth-postgres');
  return process.env.POSTGRES_URL ? pg.user : sqlite.user;
}

let cachedAdminEmails: Set<string> | null = null;
let cachedAdminEmailsRaw: string | null = null;

/** Parse ADMIN_EMAILS env. Memoized but invalidated when the env value changes. */
export function getAdminEmailSet(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? '';
  if (cachedAdminEmails && cachedAdminEmailsRaw === raw) {
    return cachedAdminEmails;
  }
  const next = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed) next.add(trimmed);
  }
  cachedAdminEmails = next;
  cachedAdminEmailsRaw = raw;
  return next;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmailSet().has(email.trim().toLowerCase());
}

/**
 * Idempotently keep `user.is_admin` in sync with the ADMIN_EMAILS env.
 *
 * Called from:
 *   - Better Auth's `databaseHooks.user.create.after` (so newly-signed-up
 *     admins are promoted on first login).
 *   - `getAuthContext()` (so removing an email from the env demotes the user
 *     on the next session resolution).
 *
 * Returns the resolved isAdmin value. Swallows DB errors (e.g. before
 * migrations have run) and returns the user's current flag value.
 */
export async function syncAdminFlag(
  userId: string,
  email: string | null | undefined,
  currentIsAdmin: boolean,
): Promise<boolean> {
  const shouldBeAdmin = isAdminEmail(email);
  if (shouldBeAdmin === currentIsAdmin) return currentIsAdmin;

  try {
    const user = getUserTable();
    await db.update(user).set({ isAdmin: shouldBeAdmin }).where(eq(user.id, userId));
    return shouldBeAdmin;
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'admin.email_sync.user_flag_update.failed',
      msg: 'Failed to sync isAdmin flag for user',
      step: 'sync_admin_flag',
      context: { userIdHash: hashForLog(userId) },
      error,
    });
    return currentIsAdmin;
  }
}
