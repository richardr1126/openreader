import { asc, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { adminProviders, adminSettings } from '@/db/schema';
import { serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

/**
 * Runtime config: site-wide settings that are persisted in admin_settings.
 * Each key has:
 *   - a TypeScript value type
 *   - a default used when no DB value exists
 *   - a validator for admin/seed writes
 */

export type RuntimeConfigSource = 'json-seed' | 'env-seed' | 'admin';

export interface RuntimeConfigKeyDef<T> {
  /** TS-level default. Used when neither DB nor env have a value. */
  default: T;
  /** Validate an incoming admin-supplied value. */
  validate(value: unknown): T | undefined;
}

function booleanFlag(defaultValue: boolean): RuntimeConfigKeyDef<boolean> {
  return {
    default: defaultValue,
    validate(value) {
      if (typeof value === 'boolean') return value;
      return undefined;
    },
  };
}

function runtimeBoolean(defaultValue: boolean): RuntimeConfigKeyDef<boolean> {
  return {
    default: defaultValue,
    validate(value) {
      if (typeof value === 'boolean') return value;
      return undefined;
    },
  };
}

function stringValue(defaultValue: string): RuntimeConfigKeyDef<string> {
  return {
    default: defaultValue,
    validate(value) {
      if (typeof value === 'string') return value;
      return undefined;
    },
  };
}

function positiveIntValue(defaultValue: number): RuntimeConfigKeyDef<number> {
  return {
    default: defaultValue,
    validate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined;
      return Math.floor(value);
    },
  };
}

export const RUNTIME_CONFIG_SCHEMA = {
  defaultTtsProvider: stringValue('custom-openai'),
  changelogFeedUrl: stringValue('https://docs.openreader.richardr.dev/changelog/manifest.json'),
  enableUserSignups: booleanFlag(true),
  restrictUserApiKeys: booleanFlag(true),
  // Historically the env semantics were "true unless explicitly 'false'",
  // i.e. the feature defaults to ON.
  enableTtsProvidersTab: booleanFlag(true),
  enableAudiobookExport: booleanFlag(true),
  enableDocxConversion: booleanFlag(true),
  showAllProviderModels: runtimeBoolean(true),
  disableTtsRateLimit: booleanFlag(true),
  ttsDailyLimitAnonymous: positiveIntValue(50_000),
  ttsDailyLimitAuthenticated: positiveIntValue(500_000),
  ttsIpDailyLimitAnonymous: positiveIntValue(100_000),
  ttsIpDailyLimitAuthenticated: positiveIntValue(1_000_000),
  ttsCacheMaxSizeBytes: positiveIntValue(256 * 1024 * 1024),
  ttsCacheTtlMs: positiveIntValue(1000 * 60 * 30),
  ttsUpstreamMaxRetries: positiveIntValue(2),
  ttsUpstreamTimeoutMs: positiveIntValue(285_000),
  // Per-user throttle for expensive PDF-layout parsing. Disabled by default
  // (admins enable it in Settings → Admin), mirroring disableTtsRateLimit.
  // When enabled, the sub-limits below apply (admin-tunable, no env seed):
  // a short "burst" window plus a wider "sustained" window that also bounds
  // concurrency (the worker caps each job's duration).
  disableComputeRateLimit: booleanFlag(true),
  computeParseBurstMax: positiveIntValue(8),
  computeParseBurstWindowSec: positiveIntValue(60),
  computeParseSustainedMax: positiveIntValue(24),
  computeParseSustainedWindowSec: positiveIntValue(600),
  // Maximum size (MB) accepted for a single document upload.
  maxUploadMb: positiveIntValue(200),
} as const satisfies Record<string, RuntimeConfigKeyDef<unknown>>;

export type RuntimeConfigKey = keyof typeof RUNTIME_CONFIG_SCHEMA;

export type RuntimeConfig = {
  [K in RuntimeConfigKey]: typeof RUNTIME_CONFIG_SCHEMA[K] extends RuntimeConfigKeyDef<infer T>
    ? T
    : never;
};

export type RuntimeConfigEntry = {
  key: RuntimeConfigKey;
  value: RuntimeConfig[RuntimeConfigKey];
  source: RuntimeConfigSource | 'default';
};

const RUNTIME_KEYS = Object.keys(RUNTIME_CONFIG_SCHEMA) as RuntimeConfigKey[];

async function resolveImplicitDefaultTtsProvider(): Promise<string | undefined> {
  try {
    const rows = await db
      .select({ slug: adminProviders.slug })
      .from(adminProviders)
      .where(eq(adminProviders.enabled, 1))
      .orderBy(
        desc(adminProviders.updatedAt),
        desc(adminProviders.createdAt),
        asc(adminProviders.slug),
      );
    const slugs = (rows as Array<{ slug: string }>).map((row) => row.slug);
    // Prefer the conventional 'default-openai' slug when present, otherwise fall
    // back to the first enabled shared provider so a fresh instance with any
    // configured provider resolves to a real, usable provider rather than the
    // built-in 'custom-openai' placeholder.
    if (slugs.includes('default-openai')) return 'default-openai';
    return slugs[0];
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'admin.runtime_config.default_provider_lookup.failed',
      msg: 'Implicit defaultTtsProvider lookup failed',
      step: 'resolve_implicit_default_provider',
      error,
    });
    return undefined;
  }
}

function buildDefaults(): RuntimeConfig {
  const out = {} as RuntimeConfig;
  for (const key of RUNTIME_KEYS) {
    (out as Record<string, unknown>)[key] = RUNTIME_CONFIG_SCHEMA[key].default;
  }
  return out;
}

async function readAllRows(): Promise<Map<string, { value: unknown; source: string }>> {
  try {
    const rows = await db.select().from(adminSettings);
    const out = new Map<string, { value: unknown; source: string }>();
    for (const row of rows as Array<{ key: string; valueJson: unknown; source: string }>) {
      const parsed = parseStoredValue(row.valueJson);
      out.set(row.key, { value: parsed, source: row.source });
    }
    return out;
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'admin.runtime_config.read.failed',
      msg: 'Runtime config read failed',
      step: 'read_runtime_config_rows',
      error,
    });
    return new Map();
  }
}

function parseStoredValue(stored: unknown): unknown {
  // Postgres jsonb returns the parsed value; SQLite text stores JSON strings.
  if (typeof stored === 'string') {
    try {
      return JSON.parse(stored);
    } catch {
      return stored;
    }
  }
  return stored;
}

function serializeForStorage(value: unknown): unknown {
  // Use JSON.stringify for SQLite-friendly text storage; Postgres jsonb
  // accepts a JS object, but a JSON string is equally valid (Postgres parses
  // it). Storing as string makes the two dialects behave identically.
  return JSON.stringify(value);
}

/** Resolve the full runtime config, DB overlaid on defaults. */
export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const out = buildDefaults();
  const rows = await readAllRows();
  let implicitDefaultTtsProvider: string | null | undefined;
  for (const key of RUNTIME_KEYS) {
    const row = rows.get(key);
    if (!row) {
      if (key === 'defaultTtsProvider') {
        if (implicitDefaultTtsProvider === undefined) {
          implicitDefaultTtsProvider = (await resolveImplicitDefaultTtsProvider()) ?? null;
        }
        if (implicitDefaultTtsProvider) {
          (out as Record<string, unknown>)[key] = implicitDefaultTtsProvider;
        }
      }
      continue;
    }
    const validated = RUNTIME_CONFIG_SCHEMA[key].validate(row.value);
    if (validated !== undefined) {
      (out as Record<string, unknown>)[key] = validated;
    }
  }
  return out;
}

/** Like getRuntimeConfig() but also reports the source of each value. */
export async function getRuntimeConfigWithSources(): Promise<{
  values: RuntimeConfig;
  sources: Record<RuntimeConfigKey, RuntimeConfigSource | 'default'>;
}> {
  const values = buildDefaults();
  const sources = {} as Record<RuntimeConfigKey, RuntimeConfigSource | 'default'>;
  const rows = await readAllRows();
  let implicitDefaultTtsProvider: string | null | undefined;
  for (const key of RUNTIME_KEYS) {
    const row = rows.get(key);
    if (!row) {
      if (key === 'defaultTtsProvider') {
        if (implicitDefaultTtsProvider === undefined) {
          implicitDefaultTtsProvider = (await resolveImplicitDefaultTtsProvider()) ?? null;
        }
        if (implicitDefaultTtsProvider) {
          (values as Record<string, unknown>)[key] = implicitDefaultTtsProvider;
        }
      }
      sources[key] = 'default';
      continue;
    }
    const validated = RUNTIME_CONFIG_SCHEMA[key].validate(row.value);
    if (validated !== undefined) {
      (values as Record<string, unknown>)[key] = validated;
      sources[key] = (
        row.source === 'env-seed'
        || row.source === 'json-seed'
        ? row.source
        : 'admin'
      );
    } else {
      sources[key] = 'default';
    }
  }
  return { values, sources };
}

/** Set a single runtime config key (admin write). Flips source to 'admin'. */
export async function setRuntimeConfigKey<K extends RuntimeConfigKey>(
  key: K,
  value: RuntimeConfig[K],
): Promise<void> {
  const def = RUNTIME_CONFIG_SCHEMA[key] as RuntimeConfigKeyDef<RuntimeConfig[K]>;
  const validated = def.validate(value);
  if (validated === undefined) {
    throw new Error(`Invalid value for runtime config key "${key}"`);
  }
  const serialized = serializeForStorage(validated);
  const now = Date.now();
  await db
    .insert(adminSettings)
    .values({ key, valueJson: serialized as never, source: 'admin', updatedAt: now })
    .onConflictDoUpdate({
      target: adminSettings.key,
      set: { valueJson: serialized as never, source: 'admin', updatedAt: now },
    });
}

/** Delete a runtime config row (resets to default/implicit behavior). */
export async function clearRuntimeConfigKey(key: RuntimeConfigKey): Promise<void> {
  await db.delete(adminSettings).where(eq(adminSettings.key, key));
}

/**
 * First-run seed from a parsed object. Only inserts keys that are absent,
 * never overwriting an existing row.
 */
export async function seedRuntimeConfigFromValues(
  input: Record<string, unknown>,
  source: RuntimeConfigSource = 'json-seed',
): Promise<{ seeded: RuntimeConfigKey[]; invalid: string[]; unknown: string[] }> {
  const seeded: RuntimeConfigKey[] = [];
  const invalid: string[] = [];
  const unknown: string[] = [];
  const validEntries: Array<{ key: RuntimeConfigKey; value: RuntimeConfig[RuntimeConfigKey] }> = [];
  const existing = await readAllRows();
  const now = Date.now();

  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (!RUNTIME_KEYS.includes(rawKey as RuntimeConfigKey)) {
      unknown.push(rawKey);
      continue;
    }
    const key = rawKey as RuntimeConfigKey;
    const def = RUNTIME_CONFIG_SCHEMA[key] as RuntimeConfigKeyDef<RuntimeConfig[RuntimeConfigKey]>;
    const validated = def.validate(rawValue);
    if (validated === undefined) {
      invalid.push(rawKey);
      continue;
    }
    validEntries.push({ key, value: validated });
  }

  if (unknown.length > 0 || invalid.length > 0) {
    return { seeded, invalid, unknown };
  }

  for (const entry of validEntries) {
    if (existing.has(entry.key)) continue;
    try {
      await db
        .insert(adminSettings)
        .values({
          key: entry.key,
          valueJson: serializeForStorage(entry.value) as never,
          source,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: adminSettings.key });
      seeded.push(entry.key);
    } catch (error) {
      logDegraded(serverLogger, {
        event: 'admin.runtime_config.seed.failed',
        msg: 'Runtime config seed failed',
        step: 'seed_runtime_config_key',
        context: { key: entry.key, source },
        error,
      });
    }
  }

  return { seeded, invalid, unknown };
}

export { RUNTIME_KEYS };
