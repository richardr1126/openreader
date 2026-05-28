import { db } from '@/db';
import { adminProviders, adminSettings } from '@/db/schema';
import { encryptSecret, apiKeyLast4 } from '@/lib/server/crypto/secrets';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { serverLogger } from '@/lib/server/logger';
import {
  RUNTIME_CONFIG_SCHEMA,
  seedRuntimeConfigFromEnv,
} from '@/lib/server/admin/settings';
import { logDegraded } from '@/lib/server/errors/logging';

/**
 * Idempotent boot-time seeding for the admin layer. Safe to call multiple
 * times. Runs:
 *
 *   1. `seedRuntimeConfigFromEnv()` — for each `RUNTIME_SEED_*` env var that
 *      maps to a runtime config key, write the value as `source='env-seed'`.
 *
 *   2. Default admin provider seed — if `admin_providers` is empty AND
 *      `API_KEY` is set, create a single `default-openai` row from the
 *      legacy `API_KEY` / `API_BASE` env vars. After this runs, the TTS
 *      routes no longer fall back to those env vars.
 *
 *   3. Legacy row cleanup — remove historical env-seeded
 *      `defaultTtsProvider="default-openai"` rows so the shared default is
 *      treated as an implicit baseline, not an override.
 */

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
      // Reset so a subsequent call can retry (e.g. once migrations run).
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
  await seedRuntimeConfigFromEnv();
  await seedDefaultAdminProvider();
  await cleanupLegacyDefaultTtsProviderSeedRow();
  await cleanupLegacyDefaultTtsModelRows();
}

async function seedDefaultAdminProvider(): Promise<void> {
  const apiKey = process.env.API_KEY;
  if (!apiKey || !apiKey.trim()) return;

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

  const baseUrl = process.env.API_BASE?.trim() || null;
  const now = Date.now();
  let enc: ReturnType<typeof encryptSecret>;
  try {
    enc = encryptSecret(apiKey);
  } catch (error) {
    const hasExplicitRestriction =
      Boolean(
        RUNTIME_CONFIG_SCHEMA.restrictUserApiKeys.envVar
        && process.env[RUNTIME_CONFIG_SCHEMA.restrictUserApiKeys.envVar]?.trim(),
      );
    if (!hasExplicitRestriction) {
      try {
        await db
          .insert(adminSettings)
          .values({
            key: 'restrictUserApiKeys',
            valueJson: JSON.stringify(false) as never,
            source: 'env-seed',
            updatedAt: now,
          })
          .onConflictDoNothing({ target: adminSettings.key });
        logDegraded(serverLogger, {
          event: 'admin.seed.restrict_user_api_keys.defaulted',
          msg: 'API_KEY present but AUTH_SECRET missing; defaulting restrictUserApiKeys=false',
          step: 'set_restrict_user_api_keys_fallback',
        });
      } catch (fallbackError) {
        logDegraded(serverLogger, {
          event: 'admin.seed.restrict_user_api_keys.fallback_write_failed',
          msg: 'Failed to write restrictUserApiKeys fallback after encryption failure',
          step: 'set_restrict_user_api_keys_fallback',
          error: fallbackError,
        });
      }
    }
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
    }, 'Created default-openai admin provider from env');
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
  // If an explicit env default exists, keep env-seeded behavior.
  const explicit = RUNTIME_CONFIG_SCHEMA.defaultTtsProvider.envVar
    ? process.env[RUNTIME_CONFIG_SCHEMA.defaultTtsProvider.envVar]
    : undefined;
  if (explicit && explicit.trim()) return;

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
