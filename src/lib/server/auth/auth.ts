import { betterAuth } from "better-auth";
import { APIError } from 'better-auth/api';
import { nextCookies } from "better-auth/next-js";
import { anonymous } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from 'drizzle-orm';
import { after, NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from "@openreader/database";
import { getRequiredAuthEnv, isAnonymousAuthSessionsEnabled } from "@/lib/server/auth/config";
import { ensureInitialAdmin } from '@/lib/server/auth/bootstrap-admin';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { assertUserSignupAllowed, initialAccessStatus } from '@/lib/server/auth/signup-policy';
import * as authSchemaSqlite from "@openreader/database/schema-auth-sqlite";
import * as authSchemaPostgres from "@openreader/database/schema-auth-postgres";
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded, logServerError } from '@/lib/server/errors/logging';
import { tryGetOrigin } from "@/lib/shared/urls";
import { isAccountEmailEnabled } from '@/lib/server/admin/email-settings';

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
const authUserTable = authSchema.user;
const requiredAuthEnv = getRequiredAuthEnv();

const createAuth = (accountEmailsEnabled: boolean, approvalRequired: boolean) => betterAuth({
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
    autoSignIn: !approvalRequired,
    requireEmailVerification: accountEmailsEnabled,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    ...(accountEmailsEnabled ? {
      async sendResetPassword(data: { user: { email: string }; url: string }) {
        const { enqueueAccountEmail } = await import('@/lib/server/email/delivery');
        await enqueueAccountEmail({
          purpose: 'password_reset',
          recipient: data.user.email,
          actionUrl: data.url,
        });
      },
    } : {}),
  },
  ...(accountEmailsEnabled ? {
    emailVerification: {
      expiresIn: 60 * 60,
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      async sendVerificationEmail(data: { user: { email: string }; url: string }) {
        const { enqueueAccountEmail } = await import('@/lib/server/email/delivery');
        await enqueueAccountEmail({
          purpose: 'email_verification',
          recipient: data.user.email,
          actionUrl: data.url,
        });
      },
    },
  } : {}),
  user: {
    changeEmail: {
      // A new address never replaces the old one until the delivery-backed
      // verification link has been completed.
      enabled: accountEmailsEnabled,
    },
    additionalFields: {
      isAdmin: {
        type: 'boolean',
        required: false,
        defaultValue: false,
        input: false,
      },
      adminSource: {
        type: 'string',
        required: false,
        defaultValue: 'none',
        input: false,
      },
      accessStatus: {
        type: 'string',
        required: false,
        defaultValue: 'active',
        input: false,
      },
    },
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        const { assertNotLastAdmin } = await import('@/lib/server/admin/users');
        await assertNotLastAdmin({
          isAdmin: Boolean((user as typeof user & { isAdmin?: boolean }).isAdmin),
          accessStatus: (user as typeof user & { accessStatus?: 'active' | 'pending' | 'suspended' }).accessStatus ?? 'active',
        });
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
          const isAnonymous = Boolean((user as { isAnonymous?: boolean }).isAnonymous);
          assertUserSignupAllowed({
            signupPolicy: runtimeConfig.signupPolicy,
            isAnonymous,
          });
          return {
            data: {
              ...user,
              isAdmin: false,
              adminSource: 'none',
              accessStatus: initialAccessStatus({
                signupPolicy: runtimeConfig.signupPolicy,
                isAnonymous,
              }),
            },
          };
        },
      },
    },
    account: {
      update: {
        after: async (account, context) => {
          // The one-time bootstrap account cannot administer the instance
          // until its deployment-provided password has been replaced.
          if (account.providerId !== 'credential' || !account.password
            || (context?.path !== '/change-password' && context?.path !== '/reset-password')) return;
          await db.update(authUserTable).set({ isAdmin: true, adminSource: 'managed' })
            .where(and(eq(authUserTable.id, account.userId), eq(authUserTable.adminSource, 'bootstrap')));
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const rows = await db
            .select({ accessStatus: authUserTable.accessStatus })
            .from(authUserTable)
            .where(eq(authUserTable.id, session.userId))
            .limit(1) as Array<{ accessStatus?: string | null }>;
          const accessStatus = rows[0]?.accessStatus ?? 'active';
          if (accessStatus === 'pending') {
            throw new APIError('FORBIDDEN', {
              code: 'ACCOUNT_PENDING_APPROVAL',
              message: 'Your account is waiting for administrator approval.',
            });
          }
          if (accessStatus === 'suspended') {
            throw new APIError('FORBIDDEN', {
              code: 'ACCOUNT_SUSPENDED',
              message: 'Your account has been suspended by an administrator.',
            });
          }
          return { data: session };
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
      enabled: false, // admin role/access changes must revoke sessions immediately
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
              const claimData = await import('@/lib/server/user/claim-data');

              const transferred = await claimData.claimAnonymousData(
                newUser.user.id,
                anonymousUser.user.id,
                null,
                { cleanupLegacySources: false },
              );
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
  advanced: {
    backgroundTasks: {
      handler: (promise) => after(async () => { await promise; }),
    },
  },
});

const authInstances = new Map<string, ReturnType<typeof createAuth>>();

/** Resolve the Better Auth configuration for the current saved email policy. */
export async function getAuth(): Promise<ReturnType<typeof createAuth>> {
  let enabled: boolean;
  try {
    enabled = await isAccountEmailEnabled();
  } catch (error) {
    // Verification is security policy. If configuration cannot be read, never
    // silently downgrade a previously-enabled (or unknown) instance.
    enabled = true;
    logDegraded(serverLogger, {
      event: 'auth.email_policy.resolve.failed',
      msg: 'Account email policy read failed; using fail-closed auth configuration',
      step: 'resolve_account_email_policy',
      error,
    });
  }
  // Better Auth captures autoSignIn at construction time, while the admin may
  // change signup policy without restarting the app.
  const approvalRequired = (await getResolvedRuntimeConfig()).signupPolicy === 'approval';
  await ensureInitialAdmin();
  const cacheKey = `${enabled}:${approvalRequired}`;
  let instance = authInstances.get(cacheKey);
  if (!instance) {
    instance = createAuth(enabled, approvalRequired);
    authInstances.set(cacheKey, instance);
  }
  return instance;
}

type AuthInstance = ReturnType<typeof createAuth>;
export type Session = AuthInstance["$Infer"]["Session"];
type AuthSessionUser = AuthInstance["$Infer"]["Session"]["user"];
export type User = AuthSessionUser & {
  isAnonymous?: boolean;
  accessStatus?: 'active' | 'pending' | 'suspended';
};

export type AuthContext = {
  session: Session | null;
  user: User | null;
  userId: string | null;
};

export async function getAuthContext(request: Pick<NextRequest, 'headers'>): Promise<AuthContext> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  const user = (session?.user ?? null) as User | null;
  const userId = user?.id ?? null;

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
