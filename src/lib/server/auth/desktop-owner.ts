import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { eq, sql } from 'drizzle-orm';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import { adminSettings } from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { markInitialAdminBootstrapped } from '@/lib/server/auth/bootstrap-admin';
import { invalidateRuntimeConfigCache, setRuntimeConfigKey } from '@/lib/server/admin/settings';
import { serverLogger } from '@/lib/server/logger';
import { logServerError } from '@/lib/server/errors/logging';

const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;

/**
 * The desktop owner's address. `.localhost` is reserved (RFC 6761) and never
 * deliverable; account email delivery refuses it as well.
 */
export const DESKTOP_OWNER_EMAIL = 'owner@openreader.localhost';
const DESKTOP_OWNER_KEY = 'desktopOwner';
export const DESKTOP_SESSION_PATH = '/desktop/session';

type RejectReason = 'missing_token' | 'token_mismatch' | 'browser_request';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison: both sides are hashed to equal-length digests first. */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

function bearerToken(headers: Headers): string | null {
  const header = headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * The shell calls the exchange from its main process, which sends no Origin and
 * no Fetch Metadata. A browser page always sends at least one of them, so their
 * presence alone refuses the request (CSRF and DNS-rebinding defence).
 */
function rejectReason(headers: Headers, expected: string): RejectReason | null {
  if (headers.has('origin') || headers.has('sec-fetch-site')) return 'browser_request';
  const presented = bearerToken(headers);
  if (!presented) return 'missing_token';
  return tokenMatches(presented, expected) ? null : 'token_mismatch';
}

function readOwnerId(stored: unknown): string | null {
  let value = stored;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const userId = (value as { userId?: unknown } | null)?.userId;
  return typeof userId === 'string' && userId ? userId : null;
}

/**
 * Return the desktop owner's user id, creating the owner on first use.
 *
 * Creation happens in one transaction: an active managed admin with no
 * credential account, the owner record, the first-admin bootstrap marker (so
 * the password bootstrap stays inert), closed sign-ups and guest sessions off.
 * Later calls only read the recorded owner. If the recorded row was deleted, a
 * new owner is created; the old data stays with the old id.
 */
export async function ensureDesktopOwner(): Promise<string> {
  let created = false;
  const ownerId = await runInDbTransaction(async (conn) => {
    const recordedRows = await conn.select({ valueJson: adminSettings.valueJson }).from(adminSettings)
      .where(eq(adminSettings.key, DESKTOP_OWNER_KEY)).limit(1) as Array<{ valueJson: unknown }>;
    const recordedId = recordedRows[0] ? readOwnerId(recordedRows[0].valueJson) : null;
    if (recordedId) {
      const existing = await conn.select({ id: authSchema.user.id }).from(authSchema.user)
        .where(eq(authSchema.user.id, recordedId)).limit(1);
      if (existing.length > 0) return recordedId;
    }

    // Never adopt an account the exchange did not create.
    const occupied = await conn.select({ id: authSchema.user.id }).from(authSchema.user)
      .where(sql`lower(${authSchema.user.email}) = ${DESKTOP_OWNER_EMAIL}`).limit(1);
    if (occupied.length > 0) {
      throw new Error('The desktop owner address belongs to an account the exchange did not create');
    }

    const userId = randomUUID();
    const now = new Date();
    await conn.insert(authSchema.user).values({
      id: userId,
      name: 'Owner',
      email: DESKTOP_OWNER_EMAIL,
      emailVerified: false,
      isAnonymous: false,
      isAdmin: true,
      adminSource: 'managed',
      accessStatus: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const ownerRecord = JSON.stringify({ version: 1, userId });
    await conn.insert(adminSettings)
      .values({ key: DESKTOP_OWNER_KEY, valueJson: ownerRecord as never, source: 'admin', updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: adminSettings.key,
        set: { valueJson: ownerRecord as never, updatedAt: Date.now() },
      });
    await markInitialAdminBootstrapped(conn, userId);
    await setRuntimeConfigKey('signupPolicy', 'closed', conn);
    await setRuntimeConfigKey('allowAnonymousSessions', false, conn);
    created = true;
    return userId;
  });
  if (created) {
    // Readers that raced the uncommitted transaction must not keep the old rows.
    invalidateRuntimeConfigCache();
    serverLogger.info({ event: 'auth.desktop_owner.created' }, 'Created the desktop owner account');
  }
  return ownerId;
}

/**
 * Fifth authentication boundary: the desktop shell exchanges its per-launch
 * token for an ordinary Better Auth session for the one owner. Registered only
 * when a launch token is configured, so the path does not exist otherwise.
 */
export function desktopOwnerSession(launchToken: string): BetterAuthPlugin {
  return {
    id: 'desktop-owner-session',
    endpoints: {
      desktopOwnerSession: createAuthEndpoint(DESKTOP_SESSION_PATH, {
        method: 'POST',
        requireHeaders: true,
      }, async (ctx) => {
        const reason = rejectReason(ctx.headers, launchToken);
        if (reason) {
          serverLogger.warn({ event: 'auth.desktop_session.rejected', reason }, 'Desktop session exchange rejected');
          throw APIError.fromStatus('UNAUTHORIZED');
        }
        try {
          const ownerId = await ensureDesktopOwner();
          const owner = await ctx.context.internalAdapter.findUserById(ownerId);
          if (!owner) throw new Error('Desktop owner row is missing after creation');
          const session = await ctx.context.internalAdapter.createSession(owner.id);
          if (!session) throw new Error('Desktop owner session was not created');
          await setSessionCookie(ctx, { session, user: owner });
        } catch (error) {
          if (error instanceof APIError) throw error;
          logServerError(serverLogger, {
            event: 'auth.desktop_session.failed',
            msg: 'Desktop session exchange failed',
            error,
          });
          throw APIError.fromStatus('INTERNAL_SERVER_ERROR');
        }
        ctx.setHeader('Cache-Control', 'no-store');
        return ctx.json({ ok: true });
      }),
    },
  };
}
