import { db } from '@/db';
import { adminProviders, adminSettings } from '@/db/schema';
import { encryptSecret, apiKeyLast4 } from '@/lib/server/crypto/secrets';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { serverLogger } from '@/lib/server/logger';
import {
  seedRuntimeConfigFromValues,
} from '@/lib/server/admin/settings';
import { logDegraded } from '@/lib/server/errors/logging';
import { validateProviderType, validateSlug } from '@/lib/server/admin/providers';
import type { TtsProviderId } from '@/lib/shared/tts-provider-catalog';

/**
 * Idempotent boot-time seeding for the admin layer. Safe to call multiple times.
 *
 * v4 behavior:
 *  1) Optional JSON seed from RUNTIME_SEED_JSON_PATH or RUNTIME_SEED_JSON
 *     - runtimeConfig: strict validation against RUNTIME_CONFIG_SCHEMA
 *     - providers: optional shared providers seed list
 *  2) Legacy provider fallback: if providers were not supplied in JSON and
 *     no provider rows exist, seed default-openai from API_KEY/API_BASE.
 *  3) Legacy row cleanup for historical defaultTtsProvider/defaultTtsModel rows.
 */

const RUNTIME_SEED_JSON = 'RUNTIME_SEED_JSON';
const RUNTIME_SEED_JSON_PATH = 'RUNTIME_SEED_JSON_PATH';
const SEED_VERSION = 1;

type SeedProviderInput = {
  slug: string;
  displayName: string;
  providerType: TtsProviderId;
  apiKey?: string;
  baseUrl?: string | null;
  defaultModel?: string | null;
  defaultInstructions?: string | null;
  enabled?: boolean;
};

type ServerSeedDocument = {
  version: number;
  runtimeConfig?: Record<string, unknown>;
  providers?: SeedProviderInput[];
};

type ParsedSeedResult = {
  seed: ServerSeedDocument;
  hasProvidersSection: boolean;
};

let seedPromise: Promise<void> | null = null;

export async function ensureAdminSeed(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runSeed().catch((error) => {
      logDegraded(serverLogger, {
        event: 'admin.seed.run.failed',
        msg: 'Admin seed run failed',
        step: 'run_admin_seed',
        error,
      });
      seedPromise = null;
      throw error;
    });
  }
  try {
    await seedPromise;
  } catch {
    // Already logged. Don't surface to callers — admin layer is best-effort.
  }
}

async function runSeed(): Promise<void> {
  const parsedSeed = await loadRuntimeSeedFromEnv();

  if (parsedSeed?.seed.runtimeConfig) {
    await seedRuntimeConfigStrict(parsedSeed.seed.runtimeConfig);
  }

  if (parsedSeed?.seed.providers) {
    await seedAdminProvidersFromJson(parsedSeed.seed.providers);
  }

  if (shouldUseEnvProviderFallback(parsedSeed?.hasProvidersSection ?? false)) {
    await seedDefaultAdminProviderFromEnvFallback();
  }

  await cleanupLegacyDefaultTtsProviderSeedRow();
  await cleanupLegacyDefaultTtsModelRows();
}

function shouldUseEnvProviderFallback(hasProvidersSection: boolean): boolean {
  return !hasProvidersSection;
}

async function loadRuntimeSeedFromEnv(): Promise<ParsedSeedResult | null> {
  const pathValue = process.env[RUNTIME_SEED_JSON_PATH]?.trim();
  const inlineValue = process.env[RUNTIME_SEED_JSON]?.trim();

  if (!pathValue && !inlineValue) return null;

  const raw = pathValue
    ? await readFile(pathValue, 'utf8')
    : inlineValue as string;

  return parseRuntimeSeedDocument(raw);
}

function parseRuntimeSeedDocument(raw: string): ParsedSeedResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${RUNTIME_SEED_JSON}/${RUNTIME_SEED_JSON_PATH} JSON: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Seed JSON root must be an object');
  }

  const record = parsed as Record<string, unknown>;
  const allowedTopLevel = new Set(['version', 'runtimeConfig', 'providers']);
  const unknownTopLevel = Object.keys(record).filter((key) => !allowedTopLevel.has(key));
  if (unknownTopLevel.length > 0) {
    throw new Error(`Seed JSON contains unknown top-level keys: ${unknownTopLevel.join(', ')}`);
  }

  if (record.version !== SEED_VERSION) {
    throw new Error(`Seed JSON version must be ${SEED_VERSION}`);
  }

  let runtimeConfig: Record<string, unknown> | undefined;
  if (record.runtimeConfig !== undefined) {
    if (!record.runtimeConfig || typeof record.runtimeConfig !== 'object' || Array.isArray(record.runtimeConfig)) {
      throw new Error('Seed JSON runtimeConfig must be an object when provided');
    }
    runtimeConfig = record.runtimeConfig as Record<string, unknown>;
  }

  let providers: SeedProviderInput[] | undefined;
  if (record.providers !== undefined) {
    if (!Array.isArray(record.providers)) {
      throw new Error('Seed JSON providers must be an array when provided');
    }
    providers = record.providers.map((entry, index) => validateSeedProviderEntry(entry, index));
  }

  return {
    seed: {
      version: SEED_VERSION,
      ...(runtimeConfig ? { runtimeConfig } : {}),
      ...(providers ? { providers } : {}),
    },
    hasProvidersSection: Object.prototype.hasOwnProperty.call(record, 'providers'),
  };
}

function validateSeedProviderEntry(value: unknown, index: number): SeedProviderInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Seed JSON providers[${index}] must be an object`);
  }

  const rec = value as Record<string, unknown>;
  const allowed = new Set([
    'slug',
    'displayName',
    'providerType',
    'apiKey',
    'baseUrl',
    'defaultModel',
    'defaultInstructions',
    'enabled',
  ]);
  const unknown = Object.keys(rec).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Seed JSON providers[${index}] contains unknown keys: ${unknown.join(', ')}`);
  }

  if (typeof rec.slug !== 'string' || !rec.slug.trim()) {
    throw new Error(`Seed JSON providers[${index}].slug must be a non-empty string`);
  }
  if (typeof rec.displayName !== 'string' || !rec.displayName.trim()) {
    throw new Error(`Seed JSON providers[${index}].displayName must be a non-empty string`);
  }
  if (typeof rec.providerType !== 'string') {
    throw new Error(`Seed JSON providers[${index}].providerType must be a string`);
  }
  if (rec.apiKey !== undefined && typeof rec.apiKey !== 'string') {
    throw new Error(`Seed JSON providers[${index}].apiKey must be a string when provided`);
  }

  if (rec.baseUrl !== undefined && rec.baseUrl !== null && typeof rec.baseUrl !== 'string') {
    throw new Error(`Seed JSON providers[${index}].baseUrl must be a string or null`);
  }
  if (rec.defaultModel !== undefined && rec.defaultModel !== null && typeof rec.defaultModel !== 'string') {
    throw new Error(`Seed JSON providers[${index}].defaultModel must be a string or null`);
  }
  if (rec.defaultInstructions !== undefined && rec.defaultInstructions !== null && typeof rec.defaultInstructions !== 'string') {
    throw new Error(`Seed JSON providers[${index}].defaultInstructions must be a string or null`);
  }
  if (rec.enabled !== undefined && typeof rec.enabled !== 'boolean') {
    throw new Error(`Seed JSON providers[${index}].enabled must be a boolean when provided`);
  }

  return {
    slug: validateSlug(rec.slug),
    displayName: rec.displayName.trim(),
    providerType: validateProviderType(rec.providerType),
    ...(rec.apiKey !== undefined ? { apiKey: rec.apiKey.trim() } : {}),
    ...(rec.baseUrl !== undefined ? { baseUrl: normalizeOptionalString(rec.baseUrl) } : {}),
    ...(rec.defaultModel !== undefined ? { defaultModel: normalizeOptionalString(rec.defaultModel) } : {}),
    ...(rec.defaultInstructions !== undefined ? { defaultInstructions: normalizeOptionalString(rec.defaultInstructions) } : {}),
    ...(rec.enabled !== undefined ? { enabled: rec.enabled } : {}),
  };
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function seedRuntimeConfigStrict(input: Record<string, unknown>): Promise<void> {
  const result = await seedRuntimeConfigFromValues(input, 'json-seed');
  if (result.unknown.length > 0 || result.invalid.length > 0) {
    const issues = [
      ...(result.unknown.length > 0 ? [`unknown keys: ${result.unknown.join(', ')}`] : []),
      ...(result.invalid.length > 0 ? [`invalid values for: ${result.invalid.join(', ')}`] : []),
    ].join('; ');
    throw new Error(`Seed JSON runtimeConfig validation failed (${issues})`);
  }
}

async function seedAdminProvidersFromJson(providers: SeedProviderInput[]): Promise<void> {
  if (providers.length === 0) return;

  const now = Date.now();
  for (const provider of providers) {
    const existing = await db
      .select({ id: adminProviders.id })
      .from(adminProviders)
      .where(eq(adminProviders.slug, provider.slug))
      .limit(1);
    if (existing.length > 0) continue;

    try {
      const apiKey = provider.apiKey ?? '';
      const encrypted = encryptSecret(apiKey);
      await db.insert(adminProviders).values({
        id: randomUUID(),
        slug: provider.slug,
        displayName: provider.displayName,
        providerType: provider.providerType,
        baseUrl: provider.baseUrl ?? null,
        apiKeyCiphertext: encrypted.ciphertext,
        apiKeyIv: encrypted.iv,
        apiKeyLast4: apiKeyLast4(apiKey),
        defaultModel: provider.defaultModel ?? null,
        defaultInstructions: provider.defaultInstructions ?? null,
        enabled: provider.enabled === false ? 0 : 1,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      logDegraded(serverLogger, {
        event: 'admin.seed.provider_insert.failed',
        msg: 'Failed to seed provider from JSON seed',
        step: 'seed_json_provider',
        context: {
          providerSlug: provider.slug,
          providerDisplayName: provider.displayName,
        },
        error,
      });
    }
  }
}

async function seedDefaultAdminProviderFromEnvFallback(): Promise<void> {
  const apiKey = process.env.API_KEY?.trim() ?? '';
  const baseUrl = process.env.API_BASE?.trim() || null;
  if (!apiKey && !baseUrl) return;

  let existing: Array<unknown>;
  try {
    existing = await db.select({ id: adminProviders.id }).from(adminProviders).limit(1);
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'admin.seed.providers.check_failed',
      msg: 'Could not check admin_providers',
      step: 'check_existing_admin_providers',
      error,
    });
    return;
  }
  if (existing.length > 0) return;

  const now = Date.now();
  let enc: ReturnType<typeof encryptSecret>;
  try {
    enc = encryptSecret(apiKey);
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'admin.seed.provider_key_encrypt.failed',
      msg: 'Failed to encrypt default provider API key',
      step: 'encrypt_default_provider_key',
      error,
    });
    return;
  }

  try {
    await db.insert(adminProviders).values({
      id: randomUUID(),
      slug: 'default-openai',
      displayName: 'Default (from env)',
      providerType: 'custom-openai',
      baseUrl,
      apiKeyCiphertext: enc.ciphertext,
      apiKeyIv: enc.iv,
      apiKeyLast4: apiKeyLast4(apiKey),
      defaultModel: 'kokoro',
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    serverLogger.info({
      event: 'admin.seed.provider_insert.succeeded',
      providerSlug: 'default-openai',
    }, 'Created default-openai admin provider from env fallback');
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'admin.seed.provider_insert.failed',
      msg: 'Failed to insert default-openai provider',
      step: 'insert_default_provider',
      context: { providerSlug: 'default-openai' },
      error,
    });
  }
}

async function cleanupLegacyDefaultTtsProviderSeedRow(): Promise<void> {
  const key = 'defaultTtsProvider';
  const seededValue = JSON.stringify('default-openai');
  try {
    await db
      .delete(adminSettings)
      .where(
        and(
          eq(adminSettings.key, key),
          eq(adminSettings.source, 'env-seed'),
          eq(adminSettings.valueJson, seededValue as never),
        ),
      );
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'admin.seed.legacy_default_provider_cleanup.failed',
      msg: 'Failed to cleanup legacy defaultTtsProvider seed row',
      step: 'cleanup_legacy_default_provider_seed',
      error,
    });
  }
}

async function cleanupLegacyDefaultTtsModelRows(): Promise<void> {
  try {
    await db
      .delete(adminSettings)
      .where(eq(adminSettings.key, 'defaultTtsModel'));
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'admin.seed.legacy_default_model_cleanup.failed',
      msg: 'Failed to cleanup legacy defaultTtsModel rows',
      step: 'cleanup_legacy_default_model_rows',
      error,
    });
  }
}

export const __seedInternals = {
  runSeed,
  parseRuntimeSeedDocument,
  validateSeedProviderEntry,
  shouldUseEnvProviderFallback,
};
