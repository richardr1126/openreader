import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { userPreferences } from '@/db/schema';
import { normalizeVersion, shouldOpenChangelogForVersionChange } from '@/lib/shared/changelog';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  deserializeUserPreferencesPayload,
  extractUserPreferencesMeta,
  withUserPreferencesMeta,
  USER_PREFERENCES_LAST_SEEN_APP_VERSION_KEY,
} from '@/lib/server/user/preferences-payload';

export const dynamic = 'force-dynamic';

function serializePreferencesForDb(payload: Record<string, unknown>): Record<string, unknown> | string {
  if (process.env.POSTGRES_URL) return payload;
  return JSON.stringify(payload);
}

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
        dataJson: userPreferences.dataJson,
        clientUpdatedAtMs: userPreferences.clientUpdatedAtMs,
      })
      .from(userPreferences)
      .where(eq(userPreferences.userId, scope.ownerUserId))
      .limit(1);

    const row = rows[0];
    const existingPayload = deserializeUserPreferencesPayload(row?.dataJson);
    const existingMeta = extractUserPreferencesMeta(existingPayload);
    const lastSeenVersion = typeof existingMeta.lastSeenAppVersion === 'string'
      ? existingMeta.lastSeenAppVersion
      : null;
    const shouldOpen = shouldOpenChangelogForVersionChange(lastSeenVersion, currentVersion);
    const nextMeta = {
      ...existingMeta,
      [USER_PREFERENCES_LAST_SEEN_APP_VERSION_KEY]: currentVersion,
    };
    const dataJson = serializePreferencesForDb(withUserPreferencesMeta(existingPayload, nextMeta));
    const updatedAt = nowTimestampMs();
    const clientUpdatedAtMs = Number(row?.clientUpdatedAtMs ?? 0);

    await db
      .insert(userPreferences)
      .values({
        userId: scope.ownerUserId,
        dataJson,
        clientUpdatedAtMs: clientUpdatedAtMs > 0 ? clientUpdatedAtMs : updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [userPreferences.userId],
        set: {
          dataJson,
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
