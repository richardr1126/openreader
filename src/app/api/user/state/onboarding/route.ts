import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { userOnboarding } from '@openreader/database/schema';
import { getGuestRetentionDays } from '@/lib/server/user/guest-retention';
import { resolveUserStateScope, type ResolvedUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

async function readOnboarding({ auth, ownerUserId }: ResolvedUserStateScope) {
  const rows = await db.select().from(userOnboarding)
    .where(eq(userOnboarding.userId, ownerUserId)).limit(1);
  const row = rows[0];
  return {
    privacyAcceptedAtMs: row?.privacyAcceptedAtMs == null ? null : Number(row.privacyAcceptedAtMs),
    lastSeenAppVersion: row?.lastSeenAppVersion ?? null,
    guestRetentionSeenDays: row?.guestRetentionSeenDays ?? null,
    guestRetentionDays: auth.user?.isAnonymous ? await getGuestRetentionDays() : null,
  };
}

export async function GET(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;
    return NextResponse.json({ onboarding: await readOnboarding(scope) });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to load onboarding state',
      normalize: { code: 'USER_ONBOARDING_LOAD_FAILED', errorClass: 'db' },
    });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;
    const body = (await req.json().catch(() => null)) as {
      privacyAccepted?: unknown;
      lastSeenAppVersion?: unknown;
      guestRetentionSeenDays?: unknown;
    } | null;
    const now = nowTimestampMs();
    const privacyAcceptedAtMs = body?.privacyAccepted === true
      ? now
      : body?.privacyAccepted === false ? null : undefined;
    const lastSeenAppVersion = typeof body?.lastSeenAppVersion === 'string'
      ? body.lastSeenAppVersion.trim() || null
      : undefined;
    const guestRetentionSeenDays = Number.isInteger(body?.guestRetentionSeenDays) && Number(body?.guestRetentionSeenDays) > 0
      ? Number(body?.guestRetentionSeenDays)
      : undefined;
    if (privacyAcceptedAtMs === undefined && lastSeenAppVersion === undefined && guestRetentionSeenDays === undefined) {
      return NextResponse.json({ error: 'No valid onboarding fields provided' }, { status: 400 });
    }
    await db.insert(userOnboarding).values({
      userId: scope.ownerUserId,
      privacyAcceptedAtMs: privacyAcceptedAtMs ?? null,
      lastSeenAppVersion: lastSeenAppVersion ?? null,
      guestRetentionSeenDays: guestRetentionSeenDays ?? null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [userOnboarding.userId],
      set: {
        ...(privacyAcceptedAtMs !== undefined ? { privacyAcceptedAtMs } : {}),
        ...(lastSeenAppVersion !== undefined ? { lastSeenAppVersion } : {}),
        ...(guestRetentionSeenDays !== undefined ? { guestRetentionSeenDays } : {}),
        updatedAt: now,
      },
    });
    return NextResponse.json({ onboarding: await readOnboarding(scope) });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to update onboarding state',
      normalize: { code: 'USER_ONBOARDING_UPDATE_FAILED', errorClass: 'db' },
    });
  }
}
