import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { anonymous } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from "@/db";
import { getRequiredAuthEnv, isAnonymousAuthSessionsEnabled } from "@/lib/server/auth/config";
import { isAdminEmail, syncAdminFlag } from "@/lib/server/admin/email-sync";
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { assertUserSignupAllowed } from '@/lib/server/auth/signup-policy';
import * as authSchemaSqlite from "@/db/schema_auth_sqlite";
import * as authSchemaPostgres from "@/db/schema_auth_postgres";
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded, logServerError } from '@/lib/server/errors/logging';
import { tryGetOrigin } from "@/lib/shared/urls";

// Heavy modules (S3 SDK, blobstore, rate-limiter, claim-data) are loaded
// lazily via dynamic import() inside the beforeDelete / onLinkAccount
// callbacks to avoid inflating every serverless function that touches auth.

// ...


function getTrustedOrigins(): string[] {
  const origins = new Set<string>();
  const baseOrigin = tryGetOrigin(process.env.BASE_URL);
  if (baseOrigin) origins.add(baseOrigin);

  // Comma-separated list for local multi-host setups (e.g., localhost + LAN IP).
  const extra = (process.env.AUTH_TRUSTED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  for (const candidate of extra) {
    const origin = tryGetOrigin(candidate);
    if (origin) origins.add(origin);
  }

  return Array.from(origins);
}

function envFlagEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return defaultValue;
}

const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
const requiredAuthEnv = getRequiredAuthEnv();

const createAuth = () => betterAuth({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: drizzleAdapter(db as any, {
    provider: process.env.POSTGRES_URL ? "pg" : "sqlite",
    schema: authSchema as Record<string, unknown>,
  }),
  secret: requiredAuthEnv.authSecret,
  baseURL: requiredAuthEnv.baseUrl,
  trustedOrigins: getTrustedOrigins(),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // Set to true in production
    async sendResetPassword(data) {
      // Send an email to the user with a link to reset their password
      serverLogger.info({
        event: 'auth.password_reset.requested',
        userEmailHash: hashForLog(data.user.email),
      }, 'Password reset requested');
    },
  },
  user: {
    additionalFields: {
      isAdmin: {
        type: 'boolean',
        required: false,
        defaultValue: false,
        input: false, // never settable from the client; controlled by ADMIN_EMAILS
      },
    },
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        try {
          const { deleteUserStorageData } = await import('@/lib/server/user/data-cleanup');
          await deleteUserStorageData(user.id, null);
        } catch (error) {
          logDegraded(serverLogger, {
            event: 'auth.user_delete.storage_cleanup_failed',
            msg: 'Failed to clean up user storage before deletion',
            step: 'delete_user_storage',
            context: { userIdHash: hashForLog(user.id) },
            error,
          });
          // Without a durable cleanup queue, proceeding would permanently
          // orphan user-scoped storage and non-cascading database rows.
          throw error;
        }
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const runtimeConfig = await getResolvedRuntimeConfig();
          assertUserSignupAllowed({
            enableUserSignups: runtimeConfig.enableUserSignups,
            isAnonymous: Boolean((user as { isAnonymous?: boolean }).isAnonymous),
          });
          // Stamp newly-created users with the correct isAdmin value if their
          // email matches ADMIN_EMAILS. This avoids a follow-up UPDATE on
          // first signup. The `input: false` above prevents clients from
          // forcing isAdmin=true through signup payloads.
          if (isAdminEmail(user.email)) {
            return { data: { ...user, isAdmin: true } };
          }
          return { data: user };
        },
      },
    },
  },
  rateLimit: {
    // Better Auth built-in rate limiting is enabled by default.
    // Set DISABLE_AUTH_RATE_LIMIT=true to disable it.
    enabled: !envFlagEnabled('DISABLE_AUTH_RATE_LIMIT', false),
  },
  socialProviders: {
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      },
    }),
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days (reasonable for user experience)
    updateAge: 60 * 60 * 1, // 1 hour (refresh more frequently)
    cookieCache: {
      maxAge: 60 * 5, // 5 minutes – revalidate session against DB regularly
    },
  },
  plugins: [
    ...(isAnonymousAuthSessionsEnabled()
      ? [
        anonymous({
          onLinkAccount: async ({ anonymousUser, newUser }) => {
            try {
              // Log when anonymous user links to a real account
              serverLogger.info({
                event: 'auth.link_account.started',
                anonymousUserIdHash: hashForLog(anonymousUser.user.id),
                newUserIdHash: hashForLog(newUser.user.id),
                newUserEmailHash: hashForLog(newUser.user.email),
              }, 'Anonymous user linked to account');

              // Lazy-load heavy modules only when account linking actually happens
              const [{ rateLimiter }, claimData] = await Promise.all([
                import('@/lib/server/rate-limit/rate-limiter'),
                import('@/lib/server/user/claim-data'),
              ]);

              const transferred = await claimData.claimAnonymousData(
                newUser.user.id,
                anonymousUser.user.id,
                null,
                { cleanupLegacySources: false },
              );
              await rateLimiter.transferAnonymousUsage(anonymousUser.user.id, newUser.user.id);
              const { deleteUserStorageData } = await import('@/lib/server/user/data-cleanup');
              await deleteUserStorageData(anonymousUser.user.id, null);
              serverLogger.info({
                event: 'auth.link_account.transfer.succeeded',
                transferred,
                anonymousUserIdHash: hashForLog(anonymousUser.user.id),
                newUserIdHash: hashForLog(newUser.user.id),
              }, 'Transferred anonymous user data during account linking');
            } catch (error) {
              logServerError(serverLogger, {
                event: 'auth.link_account.failed',
                msg: 'onLinkAccount callback failed',
                error,
              });
              // Better Auth deletes the anonymous user after this callback.
              // Block linking when transfer is incomplete so data remains retryable.
              throw error;
            }
            // Note: Anonymous user will be automatically deleted after this callback completes
          },
        }),
      ]
      : []),
    // Better Auth requires cookie integration plugins last so post-hooks can
    // still append Set-Cookie headers that are forwarded to Next.js.
    nextCookies(),
  ],
});

export const auth = createAuth();

type AuthInstance = ReturnType<typeof createAuth>;
export type Session = AuthInstance["$Infer"]["Session"];
type AuthSessionUser = AuthInstance["$Infer"]["Session"]["user"];
export type User = AuthSessionUser & {
  isAnonymous?: boolean;
};

export type AuthContext = {
  session: Session | null;
  user: User | null;
  userId: string | null;
};

export async function getAuthContext(request: Pick<NextRequest, 'headers'>): Promise<AuthContext> {
  const session = await auth.api.getSession({ headers: request.headers });
  const user = (session?.user ?? null) as User | null;
  const userId = user?.id ?? null;

  // Keep user.isAdmin in sync with ADMIN_EMAILS on every session resolution.
  // Cheap when nothing changes (no-ops at the DB layer); promotes/demotes
  // when the env list is edited. Skips anonymous users (no real email).
  if (user && userId && user.email && !user.isAnonymous) {
    const current = (user as unknown as { isAdmin?: boolean }).isAdmin ?? false;
    const resolved = await syncAdminFlag(userId, user.email, current);
    if (resolved !== current) {
      (user as unknown as { isAdmin: boolean }).isAdmin = resolved;
    }
  }

  return { session, user, userId };
}

export async function requireAuthContext(
  request: Pick<NextRequest, 'headers'>,
  options?: { requireNonAnonymous?: boolean },
): Promise<AuthContext | Response> {
  const ctx = await getAuthContext(request);

  if (!ctx.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (options?.requireNonAnonymous && ctx.user?.isAnonymous) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return ctx;
}
