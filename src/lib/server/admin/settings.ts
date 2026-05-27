import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { adminProviders, adminSettings } from '@/db/schema';
import { isAuthEnabled } from '@/lib/server/auth/config';
import { serverLogger } from '@/lib/server/logger';

/**
 * Runtime config: site-wide settings that used to live in build-time env vars.
 * env vars. Each key has:
 *   - a TypeScript value type
 *   - an env var name used for the first-run seed
 *   - a parser that turns a string env value into the typed value
 *   - a default applied when neither the DB nor the env has a value
 *
 * On first boot, `seedRuntimeConfigFromEnv()` writes a row for every key
 * whose env var is set. After that, `getRuntimeConfig()` reads from DB only.
 */

export type RuntimeConfigSource = 'env-seed' | 'admin';

export interface RuntimeConfigKeyDef<T> {
  /** TS-level default. Used when neither DB nor env have a value. */
  default: T;
  /** Env var name to seed from on first run. Omit for DB/admin-only keys. */
  envVar?: string;
  /** Parse a string env value to T. Returns undefined to skip seeding. */
  parseEnv(raw: string): T | undefined;
  /** Validate an incoming admin-supplied value. */
  validate(value: unknown): T | undefined;
}

function booleanFlag(defaultValue: boolean, envVar: string): RuntimeConfigKeyDef<boolean> {
  return {
    default: defaultValue,
    envVar,
    parseEnv(raw) {
      const lower = raw.trim().toLowerCase();
      if (lower === '' ) return undefined;
      if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
      if (['0', 'false', 'no', 'off'].includes(lower)) return false;
      return undefined;
    },
    validate(value) {
      if (typeof value === 'boolean') return value;
      return undefined;
    },
  };
}

function runtimeBoolean(defaultValue: boolean): RuntimeConfigKeyDef<boolean> {
  return {
    default: defaultValue,
    parseEnv() {
      return undefined;
    },
    validate(value) {
      if (typeof value === 'boolean') return value;
      return undefined;
    },
  };
}

function stringValue(defaultValue: string, envVar: string): RuntimeConfigKeyDef<string> {
  return {
    default: defaultValue,
    envVar,
    parseEnv(raw) {
      const trimmed = raw.trim();
      return trimmed ? trimmed : undefined;
    },
    validate(value) {
      if (typeof value === 'string') return value;
      return undefined;
    },
  };
}

export const RUNTIME_CONFIG_SCHEMA = {
  defaultTtsProvider: stringValue('custom-openai', 'RUNTIME_SEED_DEFAULT_TTS_PROVIDER'),
  changelogFeedUrl: stringValue('https://docs.openreader.richardr.dev/changelog/manifest.json', 'RUNTIME_SEED_CHANGELOG_FEED_URL'),
  enableUserSignups: booleanFlag(true, 'RUNTIME_SEED_ENABLE_USER_SIGNUPS'),
  restrictUserApiKeys: booleanFlag(true, 'RUNTIME_SEED_RESTRICT_USER_API_KEYS'),
  // Historically the env semantics were "true unless explicitly 'false'",
  // i.e. the feature defaults to ON.
  enableTtsProvidersTab: booleanFlag(true, 'RUNTIME_SEED_ENABLE_TTS_PROVIDERS_TAB'),
  enableAudiobookExport: booleanFlag(true, 'RUNTIME_SEED_ENABLE_AUDIOBOOK_EXPORT'),
  enableDocxConversion: booleanFlag(true, 'RUNTIME_SEED_ENABLE_DOCX_CONVERSION'),
  enableDestructiveDeleteActions: booleanFlag(true, 'RUNTIME_SEED_ENABLE_DESTRUCTIVE_DELETE_ACTIONS'),
  showAllProviderModels: runtimeBoolean(true),
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
      .where(and(eq(adminProviders.slug, 'default-openai'), eq(adminProviders.enabled, 1)))
      .limit(1);
    return rows[0]?.slug;
  } catch (error) {
    serverLogger.warn({ err: error }, '[runtime-config] implicit defaultTtsProvider lookup failed:');
    return undefined;
  }
}

function buildDefaults(): RuntimeConfig {
  const out = {} as RuntimeConfig;
  for (const key of RUNTIME_KEYS) {
    (out as Record<string, unknown>)[key] = RUNTIME_CONFIG_SCHEMA[key].default;
  }
  // In no-auth mode there is no admin UI to configure shared providers.
  // Keep legacy BYOK available by default unless explicitly overridden.
  if (!isAuthEnabled()) {
    out.restrictUserApiKeys = false;
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
    serverLogger.warn({ err: error }, '[runtime-config] read failed (table may not exist yet):');
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
      sources[key] = (row.source === 'env-seed' ? 'env-seed' : 'admin');
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
  // Upsert with onConflict.
  const isPg = !!process.env.POSTGRES_URL;
  if (isPg) {
    await db
      .insert(adminSettings)
      .values({ key, valueJson: serialized as never, source: 'admin', updatedAt: now })
      .onConflictDoUpdate({
        target: adminSettings.key,
        set: { valueJson: serialized as never, source: 'admin', updatedAt: now },
      });
  } else {
    await db
      .insert(adminSettings)
      .values({ key, valueJson: serialized as never, source: 'admin', updatedAt: now })
      .onConflictDoUpdate({
        target: adminSettings.key,
        set: { valueJson: serialized as never, source: 'admin', updatedAt: now },
      });
  }
}

/** Delete a runtime config row (resets to env/default behavior). */
export async function clearRuntimeConfigKey(key: RuntimeConfigKey): Promise<void> {
  await db.delete(adminSettings).where(eq(adminSettings.key, key));
}

/**
 * First-run seed: for every key whose row is absent AND env var is set,
 * write a row with `source = 'env-seed'`. Idempotent — never overwrites
 * an existing row.
 */
export async function seedRuntimeConfigFromEnv(): Promise<{ seeded: RuntimeConfigKey[] }> {
  const seeded: RuntimeConfigKey[] = [];
  let existing: Map<string, { value: unknown; source: string }>;
  try {
    existing = await readAllRows();
  } catch {
    return { seeded };
  }
  const now = Date.now();
  for (const key of RUNTIME_KEYS) {
    if (existing.has(key)) continue;
    const def = RUNTIME_CONFIG_SCHEMA[key];
    if (!def.envVar) continue;
    const raw = process.env[def.envVar];
    if (raw === undefined || raw === null || raw === '') continue;
    const parsed = def.parseEnv(raw);
    if (parsed === undefined) continue;
    try {
      await db
        .insert(adminSettings)
        .values({
          key,
          valueJson: serializeForStorage(parsed) as never,
          source: 'env-seed',
          updatedAt: now,
        })
        .onConflictDoNothing({ target: adminSettings.key });
      seeded.push(key);
    } catch (error) {
      serverLogger.warn({ key: key, err: error }, '[runtime-config] seed failed for');
    }
  }
  return { seeded };
}

export { RUNTIME_KEYS };
