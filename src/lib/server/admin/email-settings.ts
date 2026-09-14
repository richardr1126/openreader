import { eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { adminSettings } from '@openreader/database/schema';
import { decryptSecret, encryptSecret } from '@/lib/server/crypto/secrets';

const EMAIL_SETTINGS_KEY = 'accountEmailDelivery';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type StoredEmailSettings = {
  schemaVersion: 1;
  enabled: boolean;
  senderName: string;
  senderEmail: string;
  replyTo: string | null;
  apiKeyCiphertext: string | null;
  apiKeyIv: string | null;
  apiKeyLast4: string | null;
};

export type AccountEmailSettings = Omit<StoredEmailSettings, 'apiKeyCiphertext' | 'apiKeyIv'> & {
  apiKey: string | null;
};

export type PublicAccountEmailSettings = {
  enabled: boolean;
  senderName: string;
  senderEmail: string;
  replyTo: string | null;
  apiKeyConfigured: boolean;
  apiKeyMask: string | null;
};

export type AccountEmailSettingsPatch = {
  enabled?: boolean;
  senderName?: string;
  senderEmail?: string;
  replyTo?: string | null;
  apiKey?: string | null;
};

export class AccountEmailSettingsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'AccountEmailSettingsError';
  }
}

const DEFAULTS: StoredEmailSettings = {
  schemaVersion: 1,
  enabled: false,
  senderName: 'OpenReader',
  senderEmail: '',
  replyTo: null,
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

function normalizeStored(value: unknown): StoredEmailSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULTS };
  const record = value as Record<string, unknown>;
  return {
    schemaVersion: 1,
    enabled: record.enabled === true,
    senderName: typeof record.senderName === 'string' ? record.senderName : DEFAULTS.senderName,
    senderEmail: typeof record.senderEmail === 'string' ? record.senderEmail : '',
    replyTo: typeof record.replyTo === 'string' && record.replyTo ? record.replyTo : null,
    apiKeyCiphertext: typeof record.apiKeyCiphertext === 'string' ? record.apiKeyCiphertext : null,
    apiKeyIv: typeof record.apiKeyIv === 'string' ? record.apiKeyIv : null,
    apiKeyLast4: typeof record.apiKeyLast4 === 'string' ? record.apiKeyLast4 : null,
  };
}

async function readStoredSettings(): Promise<StoredEmailSettings> {
  const rows = await db
    .select({ valueJson: adminSettings.valueJson })
    .from(adminSettings)
    .where(eq(adminSettings.key, EMAIL_SETTINGS_KEY))
    .limit(1);
  return normalizeStored(parseStoredValue(rows[0]?.valueJson));
}

function serializeForStorage(value: StoredEmailSettings): StoredEmailSettings | string {
  return process.env.POSTGRES_URL ? value : JSON.stringify(value);
}

function normalizeEmail(value: unknown, label: string, optional = false): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized && optional) return null;
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new AccountEmailSettingsError(`${label} must be a valid email address`);
  }
  return normalized;
}

function validateReady(settings: StoredEmailSettings): void {
  if (!settings.apiKeyCiphertext || !settings.apiKeyIv) {
    throw new AccountEmailSettingsError('Save a Resend API key before enabling account emails');
  }
  normalizeEmail(settings.senderEmail, 'Sender email');
  if (!settings.senderName.trim()) {
    throw new AccountEmailSettingsError('Sender name is required');
  }
}

export async function getAccountEmailSettings(): Promise<AccountEmailSettings> {
  const stored = await readStoredSettings();
  const { apiKeyCiphertext, apiKeyIv, ...settings } = stored;
  let apiKey: string | null = null;
  if (apiKeyCiphertext && apiKeyIv) {
    apiKey = decryptSecret(apiKeyCiphertext, apiKeyIv);
  }
  return { ...settings, apiKey };
}

export async function getPublicAccountEmailSettings(): Promise<PublicAccountEmailSettings> {
  const stored = await readStoredSettings();
  return {
    enabled: stored.enabled,
    senderName: stored.senderName,
    senderEmail: stored.senderEmail,
    replyTo: stored.replyTo,
    apiKeyConfigured: Boolean(stored.apiKeyCiphertext && stored.apiKeyIv),
    apiKeyMask: stored.apiKeyLast4 ? `••••${stored.apiKeyLast4}` : null,
  };
}

export async function isAccountEmailEnabled(): Promise<boolean> {
  const stored = await readStoredSettings();
  if (!stored.enabled) return false;
  validateReady(stored);
  return true;
}

export async function updateAccountEmailSettings(
  patch: AccountEmailSettingsPatch,
): Promise<PublicAccountEmailSettings> {
  const current = await readStoredSettings();
  const next: StoredEmailSettings = { ...current };

  if (patch.senderName !== undefined) {
    const senderName = String(patch.senderName).trim();
    if (!senderName || senderName.length > 100) {
      throw new AccountEmailSettingsError('Sender name must be between 1 and 100 characters');
    }
    next.senderName = senderName;
  }
  if (patch.senderEmail !== undefined) {
    next.senderEmail = normalizeEmail(patch.senderEmail, 'Sender email')!;
  }
  if (patch.replyTo !== undefined) {
    next.replyTo = normalizeEmail(patch.replyTo, 'Reply-to email', true);
  }
  if (patch.apiKey !== undefined) {
    const apiKey = patch.apiKey?.trim() ?? '';
    if (!apiKey) {
      next.apiKeyCiphertext = null;
      next.apiKeyIv = null;
      next.apiKeyLast4 = null;
      next.enabled = false;
    } else {
      if (apiKey.length > 512) throw new AccountEmailSettingsError('Resend API key is too long');
      const encrypted = encryptSecret(apiKey);
      next.apiKeyCiphertext = encrypted.ciphertext;
      next.apiKeyIv = encrypted.iv;
      next.apiKeyLast4 = apiKey.slice(-4);
    }
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      throw new AccountEmailSettingsError('enabled must be a boolean');
    }
    next.enabled = patch.enabled;
  }
  if (next.enabled) validateReady(next);

  await db.insert(adminSettings).values({
    key: EMAIL_SETTINGS_KEY,
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
  return getPublicAccountEmailSettings();
}
