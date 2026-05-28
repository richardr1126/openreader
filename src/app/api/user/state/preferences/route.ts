import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { userPreferences } from '@/db/schema';
import { SYNCED_PREFERENCE_KEYS, type SyncedPreferencesPatch } from '@/types/user-state';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';
import { coerceTimestampMs, nowTimestampMs } from '@/lib/shared/timestamps';
import { isTtsProviderType, type TtsProviderId } from '@/lib/shared/tts-provider-catalog';
import { listAdminProviders } from '@/lib/server/admin/providers';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { normalizeLegacyProviderRef, resolveProviderDefaults } from '@/lib/shared/tts-provider-policy';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  deserializeUserPreferencesPayload,
  extractUserPreferencesMeta,
  withUserPreferencesMeta,
  type UserPreferencesMeta,
} from '@/lib/server/user/preferences-payload';

export const dynamic = 'force-dynamic';

function serializePreferencesForDb(payload: Record<string, unknown>): Record<string, unknown> | string {
  if (process.env.POSTGRES_URL) return payload;
  return JSON.stringify(payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface PreferenceNormalizationContext {
  defaultProviderRef: string;
  showAllProviderModels: boolean;
  sharedProviders: Array<{
    slug: string;
    providerType: TtsProviderId;
    defaultModel: string | null;
    defaultInstructions: string | null;
  }>;
}

async function loadPreferenceNormalizationContext(): Promise<PreferenceNormalizationContext> {
  const [runtimeConfig, providers] = await Promise.all([
    getResolvedRuntimeConfig(),
    listAdminProviders(),
  ]);
  return {
    defaultProviderRef: runtimeConfig.defaultTtsProvider,
    showAllProviderModels: runtimeConfig.showAllProviderModels,
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
): { patch: SyncedPreferencesPatch; migrated: boolean; meta: UserPreferencesMeta } {
  const payload = deserializeUserPreferencesPayload(value);
  const meta = extractUserPreferencesMeta(payload);
  const sanitized = sanitizePreferencesPatch(payload, context, { fillMissingProvider: true });
  return { ...sanitized, meta };
}

function sanitizeSavedVoices(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof val !== 'string') continue;
    out[key] = val;
  }
  return out;
}

function sanitizePreferencesPatch(
  input: unknown,
  context: PreferenceNormalizationContext,
  options: { fillMissingProvider: boolean },
): { patch: SyncedPreferencesPatch; migrated: boolean } {
  if (!isRecord(input)) return { patch: {}, migrated: false };

  const rec = input as Record<string, unknown>;
  const out: SyncedPreferencesPatch = {};
  let migrated = false;

  const legacyProviderRef = typeof rec.ttsProvider === 'string'
    ? rec.ttsProvider
    : typeof rec.provider === 'string'
      ? rec.provider
      : '';
  const rawProviderRef = typeof rec.providerRef === 'string' ? rec.providerRef : legacyProviderRef;
  const normalizedProviderRef = normalizeLegacyProviderRef(rawProviderRef, context.defaultProviderRef);
  const providerDefaults = resolveProviderDefaults({
    providerRef: normalizedProviderRef || context.defaultProviderRef,
    providerType: isTtsProviderType(rec.providerType) ? rec.providerType : 'unknown',
    sharedProviders: context.sharedProviders,
    fallbackProviderRef: context.defaultProviderRef,
  });
  const hasLegacyProviderKey = typeof rec.ttsProvider === 'string' || typeof rec.provider === 'string';
  if (hasLegacyProviderKey || rawProviderRef !== providerDefaults.providerRef) migrated = true;

  for (const key of SYNCED_PREFERENCE_KEYS) {
    if (!(key in rec)) continue;
    const value = rec[key];

    switch (key) {
      case 'viewType':
        if (value === 'single' || value === 'dual' || value === 'scroll') out[key] = value;
        break;
      case 'voice':
      case 'ttsModel':
      case 'ttsInstructions':
        if (typeof value === 'string') out[key] = value;
        break;
      case 'providerRef':
        out[key] = providerDefaults.providerRef;
        break;
      case 'providerType':
        out[key] = providerDefaults.providerType;
        break;
      case 'voiceSpeed':
      case 'audioPlayerSpeed':
      case 'segmentPreloadDepthPages':
      case 'segmentPreloadSentenceLookahead':
      case 'ttsSegmentMaxBlockLength':
      case 'headerMargin':
      case 'footerMargin':
      case 'leftMargin':
      case 'rightMargin':
        if (Number.isFinite(value)) out[key] = Number(value);
        break;
      case 'skipBlank':
      case 'epubTheme':
      case 'pdfHighlightEnabled':
      case 'pdfWordHighlightEnabled':
      case 'epubHighlightEnabled':
      case 'epubWordHighlightEnabled':
      case 'htmlHighlightEnabled':
      case 'htmlWordHighlightEnabled':
        if (typeof value === 'boolean') out[key] = value;
        break;
      case 'savedVoices':
        out[key] = sanitizeSavedVoices(value);
        break;
      default:
        break;
    }
  }

  if ('providerRef' in out && !('providerType' in out)) {
    out.providerType = providerDefaults.providerType;
    migrated = true;
  }

  if (options.fillMissingProvider && !('providerRef' in out)) {
    out.providerRef = providerDefaults.providerRef;
    migrated = true;
  }
  if (options.fillMissingProvider && !('providerType' in out)) {
    out.providerType = providerDefaults.providerType;
    migrated = true;
  }

  const rawModel = typeof rec.ttsModel === 'string' ? rec.ttsModel.trim() : '';
  const shouldNormalizeSharedDefaultModel =
    !!providerDefaults.defaultModel
    && context.sharedProviders.some((entry) => entry.slug === providerDefaults.providerRef)
    && (rawModel.length === 0 || rawModel === 'kokoro')
    && (hasLegacyProviderKey || rawProviderRef === 'default-openai');

  if (options.fillMissingProvider && !('ttsModel' in out) && providerDefaults.defaultModel) {
    out.ttsModel = providerDefaults.defaultModel;
    migrated = true;
  } else if (shouldNormalizeSharedDefaultModel && out.ttsModel !== providerDefaults.defaultModel) {
    out.ttsModel = providerDefaults.defaultModel;
    migrated = true;
  }
  if (!context.showAllProviderModels && providerDefaults.defaultModel && out.ttsModel !== providerDefaults.defaultModel) {
    out.ttsModel = providerDefaults.defaultModel;
    migrated = true;
  }

  return { patch: out, migrated };
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
    const storedPayload = withUserPreferencesMeta(storedPatch, stored.meta);
    const clientUpdatedAtMs = Number(row?.clientUpdatedAtMs ?? 0);

    if (row && stored.migrated) {
      const updatedAt = nowTimestampMs();
      await db
        .insert(userPreferences)
        .values({
          userId: scope.ownerUserId,
          dataJson: serializePreferencesForDb(storedPayload),
          clientUpdatedAtMs: clientUpdatedAtMs > 0 ? clientUpdatedAtMs : updatedAt,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [userPreferences.userId],
          set: {
            dataJson: serializePreferencesForDb(storedPayload),
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
    const payloadWithMeta = withUserPreferencesMeta(mergedPatch, existingStored.meta);
    const dataJson = serializePreferencesForDb(payloadWithMeta);
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
