import { and, eq, inArray, not } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';

import { db } from '../../src/db';
import { adminProviders, adminSettings } from '../../src/db/schema';
import { RUNTIME_KEYS, seedRuntimeConfigFromValues } from '../../src/lib/server/admin/settings';
import { __seedInternals } from '../../src/lib/server/admin/seed';

type SettingRow = {
  key: string;
  valueJson: unknown;
  source: string;
  updatedAt: number | null;
};

type ProviderRow = {
  id: string;
  slug: string;
  displayName: string;
  providerType: string;
  baseUrl: string | null;
  apiKeyCiphertext: string;
  apiKeyIv: string;
  apiKeyLast4: string | null;
  defaultModel: string | null;
  defaultInstructions: string | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
};

async function withEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const original = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    original.set(key, process.env[key]);
    const next = values[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, previous] of original.entries()) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

function parseStoredValue(stored: unknown): unknown {
  if (typeof stored === 'string') {
    try {
      return JSON.parse(stored);
    } catch {
      return stored;
    }
  }
  return stored;
}

async function snapshotSettings(keys: string[]): Promise<SettingRow[]> {
  const rows = await db
    .select({
      key: adminSettings.key,
      valueJson: adminSettings.valueJson,
      source: adminSettings.source,
      updatedAt: adminSettings.updatedAt,
    })
    .from(adminSettings)
    .where(inArray(adminSettings.key, keys));
  return rows as SettingRow[];
}

async function restoreSettings(keys: string[], snapshot: SettingRow[]): Promise<void> {
  await db.delete(adminSettings).where(inArray(adminSettings.key, keys));
  if (snapshot.length === 0) return;

  const now = Date.now();
  for (const row of snapshot) {
    await db
      .insert(adminSettings)
      .values({
        key: row.key,
        valueJson: row.valueJson as never,
        source: row.source,
        updatedAt: row.updatedAt ?? now,
      })
      .onConflictDoUpdate({
        target: adminSettings.key,
        set: {
          valueJson: row.valueJson as never,
          source: row.source,
          updatedAt: row.updatedAt ?? now,
        },
      });
  }
}

async function snapshotProvidersBySlug(slugs: string[]): Promise<ProviderRow[]> {
  const rows = await db.select().from(adminProviders).where(inArray(adminProviders.slug, slugs));
  return rows as ProviderRow[];
}

async function restoreProvidersBySlug(slugs: string[], snapshot: ProviderRow[]): Promise<void> {
  await db.delete(adminProviders).where(inArray(adminProviders.slug, slugs));
  if (snapshot.length === 0) return;
  for (const row of snapshot) {
    await db
      .insert(adminProviders)
      .values(row)
      .onConflictDoUpdate({
        target: adminProviders.slug,
        set: {
          displayName: row.displayName,
          providerType: row.providerType,
          baseUrl: row.baseUrl,
          apiKeyCiphertext: row.apiKeyCiphertext,
          apiKeyIv: row.apiKeyIv,
          apiKeyLast4: row.apiKeyLast4,
          defaultModel: row.defaultModel,
          defaultInstructions: row.defaultInstructions,
          enabled: row.enabled,
          updatedAt: row.updatedAt,
        },
      });
  }
}

async function hasNonTestProviderRows(testSlugs: string[]): Promise<boolean> {
  const rows = await db
    .select({ slug: adminProviders.slug })
    .from(adminProviders)
    .where(not(inArray(adminProviders.slug, testSlugs)))
    .limit(1);
  return rows.length > 0;
}

describe('runtime seed JSON parsing', () => {
  test('rejects malformed JSON input', () => {
    expect(() => __seedInternals.parseRuntimeSeedDocument('{not json')).toThrow(/invalid/i);
  });

  test('rejects unknown top-level seed keys', () => {
    const raw = JSON.stringify({
      version: 1,
      runtimeConfig: { enableUserSignups: true },
      extra: true,
    });

    expect(() => __seedInternals.parseRuntimeSeedDocument(raw)).toThrow(/unknown top-level/i);
  });

  test('providers section disables env fallback path', () => {
    expect(__seedInternals.shouldUseEnvProviderFallback(false)).toBe(true);
    expect(__seedInternals.shouldUseEnvProviderFallback(true)).toBe(false);
  });
});

describe('runtime config JSON seeding', () => {
  test('seeds validated values with json-seed source and does not overwrite', async () => {
    const keys: string[] = ['enableUserSignups', 'ttsUpstreamMaxRetries'];
    const snapshot = await snapshotSettings(keys);

    try {
      await db.delete(adminSettings).where(inArray(adminSettings.key, keys));

      const first = await seedRuntimeConfigFromValues({
        enableUserSignups: false,
        ttsUpstreamMaxRetries: 9,
      }, 'json-seed');

      expect(first.unknown).toEqual([]);
      expect(first.invalid).toEqual([]);
      expect(first.seeded.sort()).toEqual(['enableUserSignups', 'ttsUpstreamMaxRetries']);

      const rowsAfterFirst = await snapshotSettings(keys);
      const byKeyFirst = new Map(rowsAfterFirst.map((row) => [row.key, row]));

      expect(parseStoredValue(byKeyFirst.get('enableUserSignups')?.valueJson)).toBe(false);
      expect(parseStoredValue(byKeyFirst.get('ttsUpstreamMaxRetries')?.valueJson)).toBe(9);
      expect(byKeyFirst.get('enableUserSignups')?.source).toBe('json-seed');
      expect(byKeyFirst.get('ttsUpstreamMaxRetries')?.source).toBe('json-seed');

      const second = await seedRuntimeConfigFromValues({
        enableUserSignups: true,
        ttsUpstreamMaxRetries: 1,
      }, 'json-seed');

      expect(second.seeded).toEqual([]);
      const rowsAfterSecond = await snapshotSettings(keys);
      const byKeySecond = new Map(rowsAfterSecond.map((row) => [row.key, row]));
      expect(parseStoredValue(byKeySecond.get('enableUserSignups')?.valueJson)).toBe(false);
      expect(parseStoredValue(byKeySecond.get('ttsUpstreamMaxRetries')?.valueJson)).toBe(9);
    } finally {
      await restoreSettings(keys, snapshot);
    }
  });

  test('strictly rejects unknown/invalid entries without writes', async () => {
    const key = 'enableUserSignups';
    const snapshot = await snapshotSettings([key]);
    try {
      await db.delete(adminSettings).where(eq(adminSettings.key, key));
      const result = await seedRuntimeConfigFromValues({
        unknownRuntimeSetting: true,
        enableUserSignups: 'false',
      }, 'json-seed');

      expect(result.unknown).toEqual(['unknownRuntimeSetting']);
      expect(result.invalid).toEqual(['enableUserSignups']);
      expect(result.seeded).toEqual([]);

      const rows = await snapshotSettings([key]);
      expect(rows).toHaveLength(0);
    } finally {
      await restoreSettings([key], snapshot);
    }
  });

  test('supports full runtime config JSON seeding across all keys', async () => {
    const keys: string[] = [...RUNTIME_KEYS];
    const snapshot = await snapshotSettings(keys);
    const fullPayload: Record<string, unknown> = {
      defaultTtsProvider: 'seed-shared-provider',
      changelogFeedUrl: 'https://example.com/changelog/manifest.json',
      enableUserSignups: false,
      restrictUserApiKeys: false,
      enableTtsProvidersTab: false,
      enableAudiobookExport: false,
      enableDocxConversion: false,
      enableDestructiveDeleteActions: false,
      showAllProviderModels: false,
      disableTtsRateLimit: false,
      ttsDailyLimitAnonymous: 12345,
      ttsDailyLimitAuthenticated: 23456,
      ttsIpDailyLimitAnonymous: 34567,
      ttsIpDailyLimitAuthenticated: 45678,
      ttsCacheMaxSizeBytes: 16 * 1024 * 1024,
      ttsCacheTtlMs: 600_000,
      ttsUpstreamMaxRetries: 3,
      ttsUpstreamTimeoutMs: 120_000,
      disableComputeRateLimit: false,
      computeParseBurstMax: 4,
      computeParseBurstWindowSec: 30,
      computeParseSustainedMax: 12,
      computeParseSustainedWindowSec: 300,
      maxUploadMb: 150,
    };
    try {
      await db.delete(adminSettings).where(inArray(adminSettings.key, keys));
      const result = await seedRuntimeConfigFromValues(fullPayload, 'json-seed');
      expect(result.unknown).toEqual([]);
      expect(result.invalid).toEqual([]);
      expect(result.seeded).toHaveLength(RUNTIME_KEYS.length);

      const rows = await snapshotSettings(keys);
      const byKey = new Map(rows.map((row) => [row.key, row]));
      expect(parseStoredValue(byKey.get('defaultTtsProvider')?.valueJson)).toBe('seed-shared-provider');
      expect(parseStoredValue(byKey.get('enableUserSignups')?.valueJson)).toBe(false);
      expect(parseStoredValue(byKey.get('ttsUpstreamTimeoutMs')?.valueJson)).toBe(120_000);
      expect(parseStoredValue(byKey.get('maxUploadMb')?.valueJson)).toBe(150);
      expect(byKey.get('defaultTtsProvider')?.source).toBe('json-seed');
    } finally {
      await restoreSettings(keys, snapshot);
    }
  });

  test('schema key set is complete for JSON seed support', () => {
    expect(RUNTIME_KEYS.length).toBeGreaterThan(0);
    expect(RUNTIME_KEYS).toContain('defaultTtsProvider');
    expect(RUNTIME_KEYS).toContain('ttsUpstreamTimeoutMs');
  });
});

describe('provider seeding and fallback precedence', () => {
  const testSlugs = ['json-seeded-provider', 'default-openai'];

  test('seeds providers from JSON and skips API_BASE/API_KEY fallback', async () => {
    const providerSnapshot = await snapshotProvidersBySlug(testSlugs);
    const runtimeSeed = JSON.stringify({
      version: 1,
      providers: [
        {
          slug: 'json-seeded-provider',
          displayName: 'JSON Seeded Provider',
          providerType: 'custom-openai',
          baseUrl: 'http://localhost:5555/v1',
          apiKey: 'seeded_provider_key_1234',
          defaultModel: 'kokoro',
          enabled: true,
        },
      ],
    });

    try {
      await db.delete(adminProviders).where(inArray(adminProviders.slug, testSlugs));

      await withEnv({
        RUNTIME_SEED_JSON: runtimeSeed,
        RUNTIME_SEED_JSON_PATH: undefined,
        API_BASE: 'http://localhost:9999/v1',
        API_KEY: 'fallback_should_not_be_used',
        AUTH_SECRET: 'seed-test-auth-secret-123',
      }, async () => {
        await __seedInternals.runSeed();
      });

      const rows = await db
        .select({
          slug: adminProviders.slug,
          displayName: adminProviders.displayName,
          providerType: adminProviders.providerType,
          baseUrl: adminProviders.baseUrl,
          defaultModel: adminProviders.defaultModel,
          apiKeyLast4: adminProviders.apiKeyLast4,
        })
        .from(adminProviders)
        .where(inArray(adminProviders.slug, testSlugs));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        slug: 'json-seeded-provider',
        displayName: 'JSON Seeded Provider',
        providerType: 'custom-openai',
        baseUrl: 'http://localhost:5555/v1',
        defaultModel: 'kokoro',
        apiKeyLast4: '1234',
      });
    } finally {
      await restoreProvidersBySlug(testSlugs, providerSnapshot);
    }
  });

  test('falls back to API_BASE/API_KEY when JSON providers are absent', async () => {
    const providerSnapshot = await snapshotProvidersBySlug(testSlugs);
    const runtimeSeed = JSON.stringify({ version: 1, runtimeConfig: { enableUserSignups: true } });

    try {
      await db.delete(adminProviders).where(inArray(adminProviders.slug, testSlugs));
      const blockedByOtherRows = await hasNonTestProviderRows(testSlugs);
      if (blockedByOtherRows) return;

      await withEnv({
        RUNTIME_SEED_JSON: runtimeSeed,
        RUNTIME_SEED_JSON_PATH: undefined,
        API_BASE: 'http://localhost:8880/v1',
        API_KEY: 'fallback_env_api_key_9876',
        AUTH_SECRET: 'seed-test-auth-secret-456',
      }, async () => {
        await __seedInternals.runSeed();
      });

      const rows = await db
        .select({
          slug: adminProviders.slug,
          displayName: adminProviders.displayName,
          providerType: adminProviders.providerType,
          baseUrl: adminProviders.baseUrl,
          defaultModel: adminProviders.defaultModel,
          apiKeyLast4: adminProviders.apiKeyLast4,
        })
        .from(adminProviders);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        slug: 'default-openai',
        displayName: 'Default (from env)',
        providerType: 'custom-openai',
        baseUrl: 'http://localhost:8880/v1',
        defaultModel: 'kokoro',
        apiKeyLast4: '9876',
      });
    } finally {
      await restoreProvidersBySlug(testSlugs, providerSnapshot);
    }
  });

  test('does not use API_BASE/API_KEY fallback when providers key is present but empty', async () => {
    const providerSnapshot = await snapshotProvidersBySlug(testSlugs);
    const runtimeSeed = JSON.stringify({ version: 1, providers: [] });

    try {
      await db.delete(adminProviders).where(inArray(adminProviders.slug, testSlugs));
      const blockedByOtherRows = await hasNonTestProviderRows(testSlugs);
      if (blockedByOtherRows) return;

      await withEnv({
        RUNTIME_SEED_JSON: runtimeSeed,
        RUNTIME_SEED_JSON_PATH: undefined,
        API_BASE: 'http://localhost:7777/v1',
        API_KEY: 'fallback_should_stay_unused_1111',
        AUTH_SECRET: 'seed-test-auth-secret-789',
      }, async () => {
        await __seedInternals.runSeed();
      });

      const rows = await db
        .select({ slug: adminProviders.slug })
        .from(adminProviders)
        .where(eq(adminProviders.slug, 'default-openai')) as Array<{ slug: string }>;
      expect(rows).toHaveLength(0);
    } finally {
      await restoreProvidersBySlug(testSlugs, providerSnapshot);
    }
  });

  test('throws on malformed runtime seed JSON during full seed execution', async () => {
    await withEnv({
      RUNTIME_SEED_JSON: '{bad json',
      RUNTIME_SEED_JSON_PATH: undefined,
      API_BASE: undefined,
      API_KEY: undefined,
      AUTH_SECRET: 'seed-test-auth-secret-abc',
    }, async () => {
      await expect(__seedInternals.runSeed()).rejects.toThrow(/invalid/i);
    });
  });
});
