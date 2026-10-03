import { eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { adminSettings } from '@openreader/database/schema';
import { decryptSecret, encryptSecret } from '@/lib/server/crypto/secrets';

const GUTENDEX_SETTINGS_KEY = 'gutendexCatalog';

/** The public instance works without a key, so the catalog is usable before an
 * admin touches anything. It is shared, and a full-text search there has been
 * seen to hang past a minute, which is why a self-hosted server and its key
 * can be configured. */
export const DEFAULT_GUTENDEX_SERVER_URL = 'https://gutendex.com';

type StoredGutendexSettings = {
  schemaVersion: 1;
  enabled: boolean;
  serverUrl: string;
  apiKeyCiphertext: string | null;
  apiKeyIv: string | null;
  apiKeyLast4: string | null;
};

export type GutendexSettings = {
  enabled: boolean;
  serverUrl: string;
  apiKey: string | null;
};

export type PublicGutendexSettings = {
  enabled: boolean;
  serverUrl: string;
  apiKeyConfigured: boolean;
  apiKeyMask: string | null;
};

export type GutendexSettingsPatch = {
  enabled?: boolean;
  serverUrl?: string;
  apiKey?: string | null;
};

export type GutendexSettingsSeed = {
  enabled: boolean;
  serverUrl: string;
  apiKey: string | null;
};

export class GutendexSettingsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'GutendexSettingsError';
  }
}

const DEFAULTS: StoredGutendexSettings = {
  schemaVersion: 1,
  enabled: true,
  serverUrl: DEFAULT_GUTENDEX_SERVER_URL,
  apiKeyCiphertext: null,
  apiKeyIv: null,
  apiKeyLast4: null,
};

function parseStoredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function normalizeStored(value: unknown): StoredGutendexSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULTS };
  const record = value as Record<string, unknown>;
  return {
    schemaVersion: 1,
    enabled: record.enabled !== false,
    serverUrl: typeof record.serverUrl === 'string' && record.serverUrl ? record.serverUrl : DEFAULTS.serverUrl,
    apiKeyCiphertext: typeof record.apiKeyCiphertext === 'string' ? record.apiKeyCiphertext : null,
    apiKeyIv: typeof record.apiKeyIv === 'string' ? record.apiKeyIv : null,
    apiKeyLast4: typeof record.apiKeyLast4 === 'string' ? record.apiKeyLast4 : null,
  };
}

async function readStoredSettings(): Promise<StoredGutendexSettings> {
  const rows = await db
    .select({ valueJson: adminSettings.valueJson })
    .from(adminSettings)
    .where(eq(adminSettings.key, GUTENDEX_SETTINGS_KEY))
    .limit(1);
  return normalizeStored(parseStoredValue(rows[0]?.valueJson));
}

function serializeForStorage(value: StoredGutendexSettings): StoredGutendexSettings | string {
  return process.env.POSTGRES_URL ? value : JSON.stringify(value);
}

/** Stores the server's root. People paste either the root or the `/books/`
 * endpoint they saw in Gutendex's docs, so a trailing `/books` is dropped and
 * the endpoint is added back when the catalog is queried. */
export function normalizeGutendexServerUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new GutendexSettingsError('Gutendex server address is required');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new GutendexSettingsError('Gutendex server address must be a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GutendexSettingsError('Gutendex server address must use http or https');
  }
  if (url.username || url.password) {
    throw new GutendexSettingsError('Put the Gutendex API key in its own field, not in the address');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/books$/i, '');
  return `${url.origin}${path}`;
}

function normalizeApiKey(value: unknown): string {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!apiKey) throw new GutendexSettingsError('Gutendex API key is required');
  if (apiKey.length > 512) throw new GutendexSettingsError('Gutendex API key is too long');
  return apiKey;
}

export async function getGutendexSettings(): Promise<GutendexSettings> {
  const stored = await readStoredSettings();
  let apiKey: string | null = null;
  if (stored.apiKeyCiphertext && stored.apiKeyIv) {
    apiKey = decryptSecret(stored.apiKeyCiphertext, stored.apiKeyIv);
  }
  return { enabled: stored.enabled, serverUrl: stored.serverUrl, apiKey };
}

export async function getPublicGutendexSettings(): Promise<PublicGutendexSettings> {
  const stored = await readStoredSettings();
  return {
    enabled: stored.enabled,
    serverUrl: stored.serverUrl,
    apiKeyConfigured: Boolean(stored.apiKeyCiphertext && stored.apiKeyIv),
    apiKeyMask: stored.apiKeyLast4 ? `••••${stored.apiKeyLast4}` : null,
  };
}

export async function isGutenbergCatalogEnabled(): Promise<boolean> {
  return (await readStoredSettings()).enabled;
}

export function parseGutendexSettingsSeed(value: unknown): GutendexSettingsSeed {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GutendexSettingsError('Seed JSON gutendex must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['enabled', 'serverUrl', 'apiKey']);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new GutendexSettingsError(`Seed JSON gutendex contains unknown keys: ${unknown.join(', ')}`);
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new GutendexSettingsError('Seed JSON gutendex.enabled must be a boolean');
  }
  if (typeof record.serverUrl !== 'string') {
    throw new GutendexSettingsError('Seed JSON gutendex.serverUrl must be a string');
  }
  if (record.apiKey !== undefined && record.apiKey !== null && typeof record.apiKey !== 'string') {
    throw new GutendexSettingsError('Seed JSON gutendex.apiKey must be a string or null');
  }
  return {
    enabled: record.enabled !== false,
    serverUrl: normalizeGutendexServerUrl(record.serverUrl),
    apiKey: typeof record.apiKey === 'string' && record.apiKey.trim() ? normalizeApiKey(record.apiKey) : null,
  };
}

/** First-boot seed. Existing catalog settings, including admin edits, always win. */
export async function seedGutendexSettings(input: GutendexSettingsSeed): Promise<boolean> {
  const existing = await db
    .select({ key: adminSettings.key })
    .from(adminSettings)
    .where(eq(adminSettings.key, GUTENDEX_SETTINGS_KEY))
    .limit(1);
  if (existing.length > 0) return false;

  const encrypted = input.apiKey ? encryptSecret(input.apiKey) : null;
  const next: StoredGutendexSettings = {
    schemaVersion: 1,
    enabled: input.enabled,
    serverUrl: input.serverUrl,
    apiKeyCiphertext: encrypted?.ciphertext ?? null,
    apiKeyIv: encrypted?.iv ?? null,
    apiKeyLast4: input.apiKey ? input.apiKey.slice(-4) : null,
  };
  await db.insert(adminSettings).values({
    key: GUTENDEX_SETTINGS_KEY,
    valueJson: serializeForStorage(next) as never,
    source: 'json-seed',
    updatedAt: Date.now(),
  }).onConflictDoNothing();
  return true;
}

export async function updateGutendexSettings(
  patch: GutendexSettingsPatch,
): Promise<PublicGutendexSettings> {
  const current = await readStoredSettings();
  const next: StoredGutendexSettings = { ...current };

  if (patch.serverUrl !== undefined) {
    next.serverUrl = normalizeGutendexServerUrl(patch.serverUrl);
  }
  if (patch.apiKey !== undefined) {
    if (patch.apiKey !== null && typeof patch.apiKey !== 'string') {
      throw new GutendexSettingsError('Gutendex API key must be a string or null');
    }
    const apiKey = patch.apiKey?.trim() ?? '';
    if (!apiKey) {
      next.apiKeyCiphertext = null;
      next.apiKeyIv = null;
      next.apiKeyLast4 = null;
    } else {
      const normalizedApiKey = normalizeApiKey(apiKey);
      const encrypted = encryptSecret(normalizedApiKey);
      next.apiKeyCiphertext = encrypted.ciphertext;
      next.apiKeyIv = encrypted.iv;
      next.apiKeyLast4 = normalizedApiKey.slice(-4);
    }
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      throw new GutendexSettingsError('enabled must be a boolean');
    }
    next.enabled = patch.enabled;
  }

  await db.insert(adminSettings).values({
    key: GUTENDEX_SETTINGS_KEY,
    valueJson: serializeForStorage(next) as never,
    source: 'admin',
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: adminSettings.key,
    set: {
      valueJson: serializeForStorage(next) as never,
      source: 'admin',
      updatedAt: Date.now(),
    },
  });
  return getPublicGutendexSettings();
}
