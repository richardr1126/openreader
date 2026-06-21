import { createDecipheriv, scryptSync } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { adminProviders } from '@openreader/database/schema';
import { isBuiltInTtsProviderId, type TtsProviderId } from '@openreader/tts/provider-catalog';

const KEY_SALT = 'openreader:admin-secrets:v1';
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;

type AdminProviderRecord = {
  slug: string;
  providerType: TtsProviderId;
  baseUrl: string | null;
  apiKeyCiphertext: string;
  apiKeyIv: string;
  defaultModel: string | null;
  defaultInstructions: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export interface ResolvedTtsCredentials {
  provider: TtsProviderId;
  apiKey: string;
  baseUrl: string | undefined;
  fromAdmin: boolean;
  adminRecord?: AdminProviderRecord;
}

let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is required to decrypt admin TTS provider credentials.');
  }
  cachedKey = scryptSync(secret, KEY_SALT, KEY_LENGTH);
  return cachedKey;
}

function decryptSecret(ciphertext: string, iv: string): string {
  const key = deriveKey();
  const ivBuffer = Buffer.from(iv, 'base64');
  const combined = Buffer.from(ciphertext, 'base64');
  if (combined.length < TAG_LENGTH) {
    throw new Error('Ciphertext too short to contain auth tag');
  }
  const encrypted = combined.subarray(0, combined.length - TAG_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, ivBuffer);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plaintext.toString('utf8');
}

function rowToRecord(row: Record<string, unknown>): AdminProviderRecord {
  return {
    slug: String(row.slug),
    providerType: String(row.providerType ?? row.provider_type) as TtsProviderId,
    baseUrl: (row.baseUrl ?? row.base_url ?? null) as string | null,
    apiKeyCiphertext: String(row.apiKeyCiphertext ?? row.api_key_ciphertext),
    apiKeyIv: String(row.apiKeyIv ?? row.api_key_iv),
    defaultModel: (row.defaultModel ?? row.default_model ?? null) as string | null,
    defaultInstructions: (row.defaultInstructions ?? row.default_instructions ?? null) as string | null,
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === '1',
    createdAt: Number(row.createdAt ?? row.created_at ?? 0),
    updatedAt: Number(row.updatedAt ?? row.updated_at ?? 0),
  };
}

async function getEnabledAdminProviderBySlug(slug: string): Promise<AdminProviderRecord | null> {
  if (!slug) return null;
  const rows = await db
    .select()
    .from(adminProviders)
    .where(and(eq(adminProviders.slug, slug), eq(adminProviders.enabled, 1)))
    .limit(1);
  const arr = rows as Array<Record<string, unknown>>;
  return arr[0] ? rowToRecord(arr[0]) : null;
}

async function listEnabledAdminProviders(): Promise<AdminProviderRecord[]> {
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

function normalizeSharedSlug(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  return isBuiltInTtsProviderId(trimmed) ? '' : trimmed;
}

function resolvePreferredSharedProvider(input: {
  providers: readonly AdminProviderRecord[];
  requestedSlug?: string | null;
  runtimeDefaultSlug?: string | null;
}): AdminProviderRecord | null {
  if (input.providers.length === 0) return null;
  const bySlug = new Map(input.providers.map((provider) => [provider.slug, provider]));
  const requested = normalizeSharedSlug(input.requestedSlug);
  if (requested && bySlug.has(requested)) return bySlug.get(requested) ?? null;
  const runtimeDefault = normalizeSharedSlug(input.runtimeDefaultSlug);
  if (runtimeDefault && bySlug.has(runtimeDefault)) return bySlug.get(runtimeDefault) ?? null;
  return bySlug.get('default-openai') ?? input.providers[0] ?? null;
}

async function resolvePreferredEnabledAdminProvider(input: {
  requestedSlug?: string | null;
  runtimeDefaultSlug?: string | null;
}): Promise<AdminProviderRecord | null> {
  return resolvePreferredSharedProvider({
    providers: await listEnabledAdminProviders(),
    requestedSlug: input.requestedSlug,
    runtimeDefaultSlug: input.runtimeDefaultSlug,
  });
}

export async function resolveTtsCredentials(opts: {
  providerHeader: string | null;
  fallbackProvider?: string;
}): Promise<ResolvedTtsCredentials | { error: 'provider_disabled' | 'provider_unknown' | 'no_shared_provider_configured'; slug: string }> {
  const requestedProvider = opts.providerHeader || opts.fallbackProvider || 'openai';
  const admin = isBuiltInTtsProviderId(requestedProvider)
    ? await resolvePreferredEnabledAdminProvider({
      requestedSlug: null,
      runtimeDefaultSlug: opts.fallbackProvider || '',
    })
    : await getEnabledAdminProviderBySlug(requestedProvider);

  if (!admin) {
    return { error: 'no_shared_provider_configured', slug: requestedProvider };
  }

  return {
    provider: admin.providerType,
    apiKey: decryptSecret(admin.apiKeyCiphertext, admin.apiKeyIv),
    baseUrl: admin.baseUrl || undefined,
    fromAdmin: true,
    adminRecord: admin,
  };
}
