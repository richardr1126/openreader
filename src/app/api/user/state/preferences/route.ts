import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { userPreferences } from '@openreader/database/schema';
import { type SyncedPreferencesPatch } from '@/types/user-state';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { coerceTimestampMs, nowTimestampMs } from '@/lib/shared/timestamps';
import { listAdminProviders } from '@/lib/server/admin/providers';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  sanitizePreferencesPatch,
  type PreferenceNormalizationContext,
} from '@/lib/server/user/preferences-normalize';

export const dynamic = 'force-dynamic';

function serializePreferencesForDb(payload: Record<string, unknown>): Record<string, unknown> | string {
  if (process.env.POSTGRES_URL) return payload;
  return JSON.stringify(payload);
}

function deserializePreferences(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function loadPreferenceNormalizationContext(): Promise<PreferenceNormalizationContext> {
  const [runtimeConfig, providers] = await Promise.all([
    getResolvedRuntimeConfig(),
    listAdminProviders(),
  ]);
  return {
    showAllProviderModels: runtimeConfig.showAllProviderModels,
    restrictUserApiKeys: runtimeConfig.restrictUserApiKeys,
    sharedProviders: providers
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        slug: entry.slug,
        providerType: entry.providerType,
        defaultModel: entry.defaultModel,
        defaultInstructions: entry.defaultInstructions,
      })),
  };
}

function parseStoredPreferences(
  value: unknown,
  context: PreferenceNormalizationContext,
): { patch: SyncedPreferencesPatch; migrated: boolean } {
  const payload = deserializePreferences(value);
  const sanitized = sanitizePreferencesPatch(payload, context, { fillMissingProvider: true });
  return { ...sanitized, migrated: sanitized.migrated || '_meta' in payload };
}

function normalizeClientUpdatedAtMs(value: unknown): number {
  const normalized = coerceTimestampMs(value, nowTimestampMs());
  if (normalized <= 0) return nowTimestampMs();
  return normalized;
}

export async function GET(req: NextRequest) {
  try {
    const normalizationContext = await loadPreferenceNormalizationContext();
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;

    const rows = await db
      .select({
        dataJson: userPreferences.dataJson,
        clientUpdatedAtMs: userPreferences.clientUpdatedAtMs,
      })
      .from(userPreferences)
      .where(eq(userPreferences.userId, scope.ownerUserId))
      .limit(1);

    const row = rows[0];
    const stored = parseStoredPreferences(row?.dataJson, normalizationContext);
    const storedPatch = stored.patch;
    const clientUpdatedAtMs = Number(row?.clientUpdatedAtMs ?? 0);

    if (row && stored.migrated) {
      const updatedAt = nowTimestampMs();
      await db
        .insert(userPreferences)
        .values({
          userId: scope.ownerUserId,
          dataJson: serializePreferencesForDb(storedPatch),
          clientUpdatedAtMs: clientUpdatedAtMs > 0 ? clientUpdatedAtMs : updatedAt,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [userPreferences.userId],
          set: {
            dataJson: serializePreferencesForDb(storedPatch),
            updatedAt,
          },
        });
    }

    return NextResponse.json({
      preferences: storedPatch,
      clientUpdatedAtMs,
      hasStoredPreferences: Boolean(row),
    });
  } catch (error) {
    serverLogger.error({
      event: 'user.preferences.load.failed',
      error: errorToLog(error),
    }, 'Failed to load user preferences');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to load user preferences',
      normalize: { code: 'USER_PREFERENCES_LOAD_FAILED', errorClass: 'db' },
    });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const normalizationContext = await loadPreferenceNormalizationContext();
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;

    const body = (await req.json().catch(() => null)) as
      | { patch?: unknown; clientUpdatedAtMs?: unknown }
      | null;
    const patch = sanitizePreferencesPatch(
      body?.patch,
      normalizationContext,
      { fillMissingProvider: false },
    ).patch;
    const clientUpdatedAtMs = normalizeClientUpdatedAtMs(body?.clientUpdatedAtMs);

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No valid preferences provided' }, { status: 400 });
    }

    const existingRows = await db
      .select({
        dataJson: userPreferences.dataJson,
        clientUpdatedAtMs: userPreferences.clientUpdatedAtMs,
      })
      .from(userPreferences)
      .where(eq(userPreferences.userId, scope.ownerUserId))
      .limit(1);
    const existing = existingRows[0];
    const existingUpdated = Number(existing?.clientUpdatedAtMs ?? 0);
    const existingStored = parseStoredPreferences(existing?.dataJson, normalizationContext);
    const existingPatch = existingStored.patch;

    if (existing && clientUpdatedAtMs < existingUpdated) {
      return NextResponse.json({
        preferences: existingPatch,
        clientUpdatedAtMs: existingUpdated,
        applied: false,
      });
    }

    const mergedPatch = { ...existingPatch, ...patch };
    const dataJson = serializePreferencesForDb(mergedPatch);
    const updatedAt = nowTimestampMs();

    await db
      .insert(userPreferences)
      .values({
        userId: scope.ownerUserId,
        dataJson,
        clientUpdatedAtMs,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [userPreferences.userId],
        set: {
          dataJson,
          clientUpdatedAtMs,
          updatedAt,
        },
      });

    return NextResponse.json({
      preferences: mergedPatch,
      clientUpdatedAtMs,
      applied: true,
    });
  } catch (error) {
    serverLogger.error({
      event: 'user.preferences.update.failed',
      error: errorToLog(error),
    }, 'Failed to update user preferences');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to update user preferences',
      normalize: { code: 'USER_PREFERENCES_UPDATE_FAILED', errorClass: 'db' },
    });
  }
}
