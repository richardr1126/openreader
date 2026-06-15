import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { userOnboarding } from '@openreader/database/schema';
import { normalizeVersion, shouldOpenChangelogForVersionChange } from '@/lib/shared/changelog';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;

    const body = (await req.json().catch(() => null)) as
      | { currentVersion?: unknown }
      | null;
    const currentVersion = normalizeVersion(
      typeof body?.currentVersion === 'string' ? body.currentVersion : '',
    );
    if (!currentVersion) {
      return NextResponse.json({ error: 'currentVersion is required' }, { status: 400 });
    }

    const rows = await db
      .select({
        lastSeenAppVersion: userOnboarding.lastSeenAppVersion,
      })
      .from(userOnboarding)
      .where(eq(userOnboarding.userId, scope.ownerUserId))
      .limit(1);

    const row = rows[0];
    const lastSeenVersion = row?.lastSeenAppVersion ?? null;
    const shouldOpen = shouldOpenChangelogForVersionChange(lastSeenVersion, currentVersion);
    const updatedAt = nowTimestampMs();

    await db
      .insert(userOnboarding)
      .values({
        userId: scope.ownerUserId,
        lastSeenAppVersion: currentVersion,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [userOnboarding.userId],
        set: {
          lastSeenAppVersion: currentVersion,
          updatedAt,
        },
      });

    return NextResponse.json({
      shouldOpen,
      currentVersion,
      lastSeenVersion,
    });
  } catch (error) {
    serverLogger.error({
      event: 'user.changelog.version_check.failed',
      error: errorToLog(error),
    }, 'Failed to check changelog version');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to check changelog version',
      normalize: { code: 'USER_CHANGELOG_VERSION_CHECK_FAILED', errorClass: 'db' },
    });
  }
}
