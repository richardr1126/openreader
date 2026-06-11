import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { adminProviders } from '@/db/schema';
import { apiKeyLast4, decryptSecret, encryptSecret } from '@/lib/server/crypto/secrets';
import { type TtsProviderId } from '@/lib/shared/tts-provider-catalog';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import { resolvePreferredSharedProviderSlug } from '@/lib/shared/shared-provider-selection';
import { getRuntimeConfig, setRuntimeConfigKey } from '@/lib/server/admin/settings';

export const BUILT_IN_PROVIDER_IDS: readonly TtsProviderId[] = [
  'custom-openai',
  'replicate',
  'deepinfra',
  'openai',
  'speech-sdk',
];

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export interface AdminProviderRecord {
  id: string;
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  baseUrl: string | null;
  apiKeyCiphertext: string;
  apiKeyIv: string;
  apiKeyLast4: string | null;
  defaultModel: string | null;
  defaultInstructions: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AdminProviderMasked {
  id: string;
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  baseUrl: string | null;
  apiKeyMask: string;
  defaultModel: string | null;
  defaultInstructions: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AdminProviderPublic {
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  defaultModel: string | null;
  defaultInstructions: string | null;
}

export interface CreateAdminProviderInput {
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  baseUrl?: string | null;
  apiKey?: string;
  defaultModel?: string | null;
  defaultInstructions?: string | null;
  enabled?: boolean;
}

export interface UpdateAdminProviderPatch {
  slug?: string;
  displayName?: string;
  providerType?: TtsProviderId;
  baseUrl?: string | null;
  /** Optional — only re-encrypts when supplied. */
  apiKey?: string;
  defaultModel?: string | null;
  defaultInstructions?: string | null;
  enabled?: boolean;
}

export class AdminProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function validateProviderType(value: unknown): TtsProviderId {
  if (typeof value !== 'string' || !BUILT_IN_PROVIDER_IDS.includes(value as TtsProviderId)) {
    throw new AdminProviderError(
      `providerType must be one of: ${BUILT_IN_PROVIDER_IDS.join(', ')}`,
      400,
    );
  }
  return value as TtsProviderId;
}

export function validateSlug(slug: unknown): string {
  if (typeof slug !== 'string') {
    throw new AdminProviderError('slug is required', 400);
  }
  const normalized = slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(normalized)) {
    throw new AdminProviderError(
      'slug must be lowercase alphanumeric or hyphens (1–64 chars, no leading/trailing hyphen)',
      400,
    );
  }
  if ((BUILT_IN_PROVIDER_IDS as readonly string[]).includes(normalized)) {
    throw new AdminProviderError(
      `slug "${normalized}" is reserved (collides with a built-in provider id)`,
      400,
    );
  }
  return normalized;
}

function rowToRecord(row: Record<string, unknown>): AdminProviderRecord {
  // The `enabled` column is integer (0/1) in SQLite and integer in Postgres
  // (we modeled it as integer there too). Either way, treat any truthy value
  // as enabled. Booleans go straight through.
  const enabled = row.enabled === true || row.enabled === 1 || row.enabled === '1';
  return {
    id: String(row.id),
    slug: String(row.slug),
    displayName: String(row.displayName ?? row.display_name),
    providerType: String(row.providerType ?? row.provider_type) as TtsProviderId,
    baseUrl: (row.baseUrl ?? row.base_url ?? null) as string | null,
    apiKeyCiphertext: String(row.apiKeyCiphertext ?? row.api_key_ciphertext),
    apiKeyIv: String(row.apiKeyIv ?? row.api_key_iv),
    apiKeyLast4: (row.apiKeyLast4 ?? row.api_key_last4 ?? null) as string | null,
    defaultModel: (row.defaultModel ?? row.default_model ?? null) as string | null,
    defaultInstructions: (row.defaultInstructions ?? row.default_instructions ?? null) as string | null,
    enabled,
    createdAt: Number(row.createdAt ?? row.created_at ?? 0),
    updatedAt: Number(row.updatedAt ?? row.updated_at ?? 0),
  };
}

export function toMasked(record: AdminProviderRecord): AdminProviderMasked {
  const last4 = (record.apiKeyLast4 ?? '').trim();
  return {
    id: record.id,
    slug: record.slug,
    displayName: record.displayName,
    providerType: record.providerType,
    baseUrl: record.baseUrl,
    apiKeyMask: last4 ? `••••${last4}` : '(not set)',
    defaultModel: record.defaultModel,
    defaultInstructions: record.defaultInstructions,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toPublic(record: AdminProviderRecord): AdminProviderPublic {
  return {
    slug: record.slug,
    displayName: record.displayName,
    providerType: record.providerType,
    defaultModel: record.defaultModel,
    defaultInstructions: record.defaultInstructions,
  };
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function assertInstructionsCompatibility(model: string | null, instructions: string | null): void {
  if (!instructions) return;
  if (!resolveTtsProviderModelPolicy({
    providerRef: '',
    providerType: 'custom-openai',
    model,
  }).supportsInstructions) {
    throw new AdminProviderError(
      'defaultInstructions is only supported for models that support TTS instructions.',
      400,
    );
  }
}

export async function listAdminProviders(): Promise<AdminProviderRecord[]> {
  const rows = await db
    .select()
    .from(adminProviders)
    .orderBy(
      desc(adminProviders.updatedAt),
      desc(adminProviders.createdAt),
      asc(adminProviders.slug),
    );
  return (rows as Array<Record<string, unknown>>).map(rowToRecord);
}

export async function listEnabledAdminProviders(): Promise<AdminProviderRecord[]> {
  const rows = await db
    .select()
    .from(adminProviders)
    .where(eq(adminProviders.enabled, 1))
    .orderBy(
      desc(adminProviders.updatedAt),
      desc(adminProviders.createdAt),
      asc(adminProviders.slug),
    );
  return (rows as Array<Record<string, unknown>>).map(rowToRecord);
}

export async function getAdminProviderBySlug(slug: string): Promise<AdminProviderRecord | null> {
  const rows = await db.select().from(adminProviders).where(eq(adminProviders.slug, slug)).limit(1);
  const arr = rows as Array<Record<string, unknown>>;
  return arr[0] ? rowToRecord(arr[0]) : null;
}

export async function getAdminProviderById(id: string): Promise<AdminProviderRecord | null> {
  const rows = await db.select().from(adminProviders).where(eq(adminProviders.id, id)).limit(1);
  const arr = rows as Array<Record<string, unknown>>;
  return arr[0] ? rowToRecord(arr[0]) : null;
}

export async function decryptedKeyFor(record: AdminProviderRecord): Promise<string> {
  return decryptSecret(record.apiKeyCiphertext, record.apiKeyIv);
}

export async function createAdminProvider(
  input: CreateAdminProviderInput,
): Promise<AdminProviderRecord> {
  const slug = validateSlug(input.slug);
  const providerType = validateProviderType(input.providerType);
  if (!input.displayName || !input.displayName.trim()) {
    throw new AdminProviderError('displayName is required', 400);
  }
  const apiKey = String(input.apiKey ?? '');
  const defaultModel = normalizeOptionalText(input.defaultModel);
  const defaultInstructions = normalizeOptionalText(input.defaultInstructions);
  assertInstructionsCompatibility(defaultModel, defaultInstructions);

  const existing = await getAdminProviderBySlug(slug);
  if (existing) {
    throw new AdminProviderError(`slug "${slug}" already exists`, 409);
  }

  const enc = encryptSecret(apiKey);
  const now = Date.now();
  const id = randomUUID();
  await db.insert(adminProviders).values({
    id,
    slug,
    displayName: input.displayName.trim(),
    providerType,
    baseUrl: input.baseUrl ?? null,
    apiKeyCiphertext: enc.ciphertext,
    apiKeyIv: enc.iv,
    apiKeyLast4: apiKeyLast4(apiKey),
    defaultModel,
    defaultInstructions,
    enabled: (input.enabled ?? true) ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  });
  const created = await getAdminProviderById(id);
  if (!created) throw new AdminProviderError('failed to create provider', 500);
  return created;
}

export async function updateAdminProvider(
  id: string,
  patch: UpdateAdminProviderPatch,
): Promise<AdminProviderRecord> {
  const current = await getAdminProviderById(id);
  if (!current) throw new AdminProviderError('provider not found', 404);
  const runtimeConfigBefore = await getRuntimeConfig();
  const wasDefaultProvider = runtimeConfigBefore.defaultTtsProvider === current.slug;

  const update: Record<string, unknown> = { updatedAt: Date.now() };
  const nextModel =
    patch.defaultModel !== undefined
      ? normalizeOptionalText(patch.defaultModel)
      : current.defaultModel;
  const nextInstructions =
    patch.defaultInstructions !== undefined
      ? normalizeOptionalText(patch.defaultInstructions)
      : current.defaultInstructions;
  assertInstructionsCompatibility(nextModel, nextInstructions);

  if (patch.slug !== undefined) {
    const slug = validateSlug(patch.slug);
    if (slug !== current.slug) {
      const dup = await getAdminProviderBySlug(slug);
      if (dup) throw new AdminProviderError(`slug "${slug}" already exists`, 409);
      update.slug = slug;
    }
  }
  if (patch.displayName !== undefined) {
    if (!patch.displayName.trim()) {
      throw new AdminProviderError('displayName cannot be empty', 400);
    }
    update.displayName = patch.displayName.trim();
  }
  if (patch.providerType !== undefined) {
    update.providerType = validateProviderType(patch.providerType);
  }
  if (patch.baseUrl !== undefined) {
    update.baseUrl = patch.baseUrl ?? null;
  }
  if (patch.defaultModel !== undefined) {
    update.defaultModel = normalizeOptionalText(patch.defaultModel);
  }
  if (patch.defaultInstructions !== undefined) {
    update.defaultInstructions = normalizeOptionalText(patch.defaultInstructions);
  }
  if (patch.enabled !== undefined) {
    update.enabled = patch.enabled ? 1 : 0;
  }
  if (patch.apiKey !== undefined && patch.apiKey !== '') {
    const enc = encryptSecret(patch.apiKey);
    update.apiKeyCiphertext = enc.ciphertext;
    update.apiKeyIv = enc.iv;
    update.apiKeyLast4 = apiKeyLast4(patch.apiKey);
  }

  await db.update(adminProviders).set(update).where(eq(adminProviders.id, id));
  const updated = await getAdminProviderById(id);
  if (!updated) throw new AdminProviderError('failed to load updated provider', 500);
  if (wasDefaultProvider) {
    if (updated.enabled && updated.slug !== current.slug) {
      await setRuntimeConfigKey('defaultTtsProvider', updated.slug);
    } else if (!updated.enabled) {
      await swapDefaultSharedProvider(updated.slug);
    }
  }
  await ensureDefaultSharedProviderValidity();
  return updated;
}

export async function deleteAdminProvider(id: string): Promise<void> {
  const existing = await getAdminProviderById(id);
  if (!existing) throw new AdminProviderError('provider not found', 404);
  const runtimeConfigBefore = await getRuntimeConfig();
  const wasDefaultProvider = runtimeConfigBefore.defaultTtsProvider === existing.slug;
  await db.delete(adminProviders).where(eq(adminProviders.id, id));
  if (wasDefaultProvider) {
    await swapDefaultSharedProvider(existing.slug);
  }
  await ensureDefaultSharedProviderValidity();
}

/** Lookup helper used by TTS routes: returns null if not found or disabled. */
export async function getEnabledAdminProviderBySlug(
  slug: string,
): Promise<AdminProviderRecord | null> {
  if (!slug) return null;
  const rows = await db
    .select()
    .from(adminProviders)
    .where(and(eq(adminProviders.slug, slug), eq(adminProviders.enabled, 1)))
    .limit(1);
  const arr = rows as Array<Record<string, unknown>>;
  return arr[0] ? rowToRecord(arr[0]) : null;
}

export async function getFirstEnabledAdminProvider(): Promise<AdminProviderRecord | null> {
  const rows = await listEnabledAdminProviders();
  return rows[0] ?? null;
}

export async function resolvePreferredEnabledAdminProvider(input: {
  requestedSlug?: string | null;
  runtimeDefaultSlug?: string | null;
}): Promise<AdminProviderRecord | null> {
  const providers = await listEnabledAdminProviders();
  const selectedSlug = resolvePreferredSharedProviderSlug({
    providers,
    requestedSlug: input.requestedSlug,
    runtimeDefaultSlug: input.runtimeDefaultSlug,
  });
  if (!selectedSlug) return null;
  return providers.find((provider) => provider.slug === selectedSlug) ?? null;
}

async function ensureDefaultSharedProviderValidity(): Promise<void> {
  const runtimeConfig = await getRuntimeConfig();
  const currentDefaultSlug = runtimeConfig.defaultTtsProvider;
  if (!currentDefaultSlug || BUILT_IN_PROVIDER_IDS.includes(currentDefaultSlug as TtsProviderId)) {
    return;
  }

  const currentDefaultEnabled = await getEnabledAdminProviderBySlug(currentDefaultSlug);
  if (currentDefaultEnabled) return;

  const nextProvider = await resolvePreferredEnabledAdminProvider({
    runtimeDefaultSlug: currentDefaultSlug,
  });
  if (!nextProvider) return;

  await setRuntimeConfigKey('defaultTtsProvider', nextProvider.slug);
}

async function swapDefaultSharedProvider(excludedSlug: string): Promise<void> {
  const providers = await listEnabledAdminProviders();
  const filtered = providers.filter((provider) => provider.slug !== excludedSlug);
  const selectedSlug = resolvePreferredSharedProviderSlug({
    providers: filtered,
    runtimeDefaultSlug: null,
  });
  if (!selectedSlug) return;
  await setRuntimeConfigKey('defaultTtsProvider', selectedSlug);
}
