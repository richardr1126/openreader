import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { anonymous } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from "@/db";
import { isAuthEnabled, isAnonymousAuthSessionsEnabled } from "@/lib/server/auth/config";
import * as authSchemaSqlite from "@/db/schema_auth_sqlite";
import * as authSchemaPostgres from "@/db/schema_auth_postgres";

// Heavy modules (S3 SDK, blobstore, rate-limiter, claim-data) are loaded
// lazily via dynamic import() inside the beforeDelete / onLinkAccount
// callbacks to avoid inflating every serverless function that touches auth.

// ...

function tryGetOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

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

const createAuth = () => betterAuth({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: drizzleAdapter(db as any, {
    provider: process.env.POSTGRES_URL ? "pg" : "sqlite",
    schema: authSchema as Record<string, unknown>,
  }),
  secret: process.env.AUTH_SECRET!,
  baseURL: process.env.BASE_URL!,
  trustedOrigins: getTrustedOrigins(),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // Set to true in production
    async sendResetPassword(data) {
      // Send an email to the user with a link to reset their password
      console.log("Password reset requested for:", data.user.email);
    },
  },
  user: {
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        try {
          const { deleteUserStorageData } = await import('@/lib/server/user/data-cleanup');
          await deleteUserStorageData(user.id, null);
        } catch (error) {
          console.error('[auth] Failed to clean up user storage before deletion:', error);
          // Don't throw – allow the user deletion to proceed even if S3 cleanup fails.
          // Orphaned blobs are preferable to a blocked account deletion.
        }
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
    nextCookies(), // Enable Next.js cookie handling
    ...(isAnonymousAuthSessionsEnabled()
      ? [
        anonymous({
          onLinkAccount: async ({ anonymousUser, newUser }) => {
            try {
              // Log when anonymous user links to a real account
              console.log("Anonymous user linked to account:", {
                anonymousUserId: anonymousUser.user.id,
                newUserId: newUser.user.id,
                newUserEmail: newUser.user.email,
              });

              // Lazy-load heavy modules only when account linking actually happens
              const [{ rateLimiter }, claimData] = await Promise.all([
                import('@/lib/server/rate-limit/rate-limiter'),
                import('@/lib/server/user/claim-data'),
              ]);

              // Transfer rate limiting data (TTS char counts) from anonymous user to authenticated user
              try {
                await rateLimiter.transferAnonymousUsage(anonymousUser.user.id, newUser.user.id);
                console.log(`Successfully transferred rate limit data from anonymous user ${anonymousUser.user.id} to user ${newUser.user.id}`);
              } catch (error) {
                console.error("Error transferring rate limit data during account linking:", error);
                // Don't throw here to prevent blocking the account linking process
              }

              // Transfer audiobooks from anonymous user to new authenticated user
              try {
                const transferred = await claimData.transferUserAudiobooks(anonymousUser.user.id, newUser.user.id);
                if (transferred > 0) {
                  console.log(`Successfully transferred ${transferred} audiobook(s) from anonymous user ${anonymousUser.user.id} to user ${newUser.user.id}`);
                }
              } catch (error) {
                console.error("Error transferring audiobooks during account linking:", error);
                // Don't throw here to prevent blocking the account linking process
              }

              // Transfer documents from anonymous user to new authenticated user
              try {
                const transferred = await claimData.transferUserDocuments(anonymousUser.user.id, newUser.user.id);
                if (transferred > 0) {
                  console.log(`Successfully transferred ${transferred} document(s) from anonymous user ${anonymousUser.user.id} to user ${newUser.user.id}`);
                }
              } catch (error) {
                console.error("Error transferring documents during account linking:", error);
                // Don't throw here to prevent blocking the account linking process
              }

              // Transfer preferences from anonymous user to new authenticated user
              try {
                const transferred = await claimData.transferUserPreferences(anonymousUser.user.id, newUser.user.id);
                if (transferred > 0) {
                  console.log(`Successfully transferred preferences from anonymous user ${anonymousUser.user.id} to user ${newUser.user.id}`);
                }
              } catch (error) {
                console.error("Error transferring preferences during account linking:", error);
                // Don't throw here to prevent blocking the account linking process
              }

              // Transfer reading progress from anonymous user to new authenticated user
              try {
                const transferred = await claimData.transferUserProgress(anonymousUser.user.id, newUser.user.id);
                if (transferred > 0) {
                  console.log(`Successfully transferred ${transferred} progress row(s) from anonymous user ${anonymousUser.user.id} to user ${newUser.user.id}`);
                }
              } catch (error) {
                console.error("Error transferring reading progress during account linking:", error);
                // Don't throw here to prevent blocking the account linking process
              }
            } catch (error) {
              console.error("Error in onLinkAccount callback:", error);
              // Don't throw here to prevent blocking the account linking process
            }
            // Note: Anonymous user will be automatically deleted after this callback completes
          },
        }),
      ]
      : []),
  ],
});

export const auth = isAuthEnabled() ? createAuth() : null;

type AuthInstance = ReturnType<typeof createAuth>;
export type Session = AuthInstance["$Infer"]["Session"];
export type User = AuthInstance["$Infer"]["Session"]["user"];

export type AuthContext = {
  authEnabled: boolean;
  session: Session | null;
  user: User | null;
  userId: string | null;
};

export async function getAuthContext(request: Pick<NextRequest, 'headers'>): Promise<AuthContext> {
  const authEnabled = isAuthEnabled();

  if (!authEnabled || !auth) {
    return { authEnabled, session: null, user: null, userId: null };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user ?? null;
  const userId = user?.id ?? null;

  return { authEnabled, session, user, userId };
}

export async function requireAuthContext(
  request: Pick<NextRequest, 'headers'>,
  options?: { requireNonAnonymous?: boolean },
): Promise<AuthContext | Response> {
  const ctx = await getAuthContext(request);

  if (!ctx.authEnabled) {
    return ctx;
  }

  if (!ctx.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (options?.requireNonAnonymous && ctx.user?.isAnonymous) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return ctx;
}
