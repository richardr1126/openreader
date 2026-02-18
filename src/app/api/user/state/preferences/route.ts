import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { userPreferences } from '@/db/schema';
import { SYNCED_PREFERENCE_KEYS, type SyncedPreferencesPatch } from '@/types/user-state';
import { resolveUserStateScope } from '@/lib/server/user/resolve-state-scope';

export const dynamic = 'force-dynamic';

function nowForDb(): Date | number {
  return process.env.POSTGRES_URL ? new Date() : Date.now();
}

function serializePreferencesForDb(patch: SyncedPreferencesPatch): SyncedPreferencesPatch | string {
  if (process.env.POSTGRES_URL) return patch;
  return JSON.stringify(patch);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStoredPreferences(value: unknown): SyncedPreferencesPatch {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? sanitizePreferencesPatch(parsed) : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? sanitizePreferencesPatch(value) : {};
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

function sanitizePreferencesPatch(input: unknown): SyncedPreferencesPatch {
  if (!isRecord(input)) return {};

  const out: SyncedPreferencesPatch = {};

  for (const key of SYNCED_PREFERENCE_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];

    switch (key) {
      case 'viewType':
        if (value === 'single' || value === 'dual' || value === 'scroll') out[key] = value;
        break;
      case 'voice':
      case 'ttsProvider':
      case 'ttsModel':
      case 'ttsInstructions':
        if (typeof value === 'string') out[key] = value;
        break;
      case 'voiceSpeed':
      case 'audioPlayerSpeed':
      case 'headerMargin':
      case 'footerMargin':
      case 'leftMargin':
      case 'rightMargin':
        if (Number.isFinite(value)) out[key] = Number(value);
        break;
      case 'skipBlank':
      case 'epubTheme':
      case 'smartSentenceSplitting':
      case 'pdfHighlightEnabled':
      case 'pdfWordHighlightEnabled':
      case 'epubHighlightEnabled':
      case 'epubWordHighlightEnabled':
        if (typeof value === 'boolean') out[key] = value;
        break;
      case 'savedVoices':
        out[key] = sanitizeSavedVoices(value);
        break;
      default:
        break;
    }
  }

  return out;
}

function normalizeClientUpdatedAtMs(value: unknown): number {
  if (!Number.isFinite(value)) return Date.now();
  const normalized = Number(value);
  if (normalized <= 0) return Date.now();
  return Math.floor(normalized);
}

export async function GET(req: NextRequest) {
  try {
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
    const storedPatch = parseStoredPreferences(row?.dataJson);
    const clientUpdatedAtMs = Number(row?.clientUpdatedAtMs ?? 0);

    return NextResponse.json({
      preferences: storedPatch,
      clientUpdatedAtMs,
      hasStoredPreferences: Boolean(row),
    });
  } catch (error) {
    console.error('Error loading user preferences:', error);
    return NextResponse.json({ error: 'Failed to load user preferences' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const scope = await resolveUserStateScope(req);
    if (scope instanceof Response) return scope;

    const body = (await req.json().catch(() => null)) as
      | { patch?: unknown; clientUpdatedAtMs?: unknown }
      | null;
    const patch = sanitizePreferencesPatch(body?.patch);
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
    const existingPatch = parseStoredPreferences(existing?.dataJson);

    if (existing && clientUpdatedAtMs < existingUpdated) {
      return NextResponse.json({
        preferences: existingPatch,
        clientUpdatedAtMs: existingUpdated,
        applied: false,
      });
    }

    const mergedPatch = { ...existingPatch, ...patch };
    const dataJson = serializePreferencesForDb(mergedPatch);
    const updatedAt = nowForDb();

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
    console.error('Error updating user preferences:', error);
    return NextResponse.json({ error: 'Failed to update user preferences' }, { status: 500 });
  }
}
