import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let stored: { valueJson: unknown } | null = null;
  return {
    reset: () => { stored = null; },
    read: () => stored,
    db: {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ limit: async () => stored ? [stored] : [] }),
        }),
      })),
      insert: vi.fn(() => ({
        values: (value: { valueJson: unknown }) => ({
          onConflictDoUpdate: async () => { stored = value; },
        }),
      })),
    },
    encryptSecret: vi.fn((value: string) => ({ ciphertext: `encrypted:${value.length}`, iv: 'unique-iv' })),
    decryptSecret: vi.fn(() => 're_super_secret'),
  };
});

vi.mock('@openreader/database', () => ({ db: mocks.db }));
vi.mock('@/lib/server/crypto/secrets', () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: mocks.decryptSecret,
}));

import {
  getAccountEmailSettings,
  updateAccountEmailSettings,
} from '../../src/lib/server/admin/email-settings';

describe('account email settings', () => {
  beforeEach(() => {
    mocks.reset();
    mocks.encryptSecret.mockClear();
    mocks.decryptSecret.mockClear();
  });

  test('encrypts the Resend key at rest and only exposes its mask publicly', async () => {
    const publicSettings = await updateAccountEmailSettings({
      senderName: 'OpenReader Mail',
      senderEmail: 'Mail@Example.com',
      apiKey: 're_super_secret',
      enabled: true,
    });

    const persisted = mocks.read();
    const stored = typeof persisted?.valueJson === 'string'
      ? JSON.parse(persisted.valueJson) as Record<string, unknown>
      : persisted?.valueJson as Record<string, unknown>;
    expect(mocks.encryptSecret).toHaveBeenCalledWith('re_super_secret');
    expect(JSON.stringify(stored)).not.toContain('re_super_secret');
    expect(stored).toMatchObject({
      enabled: true,
      senderEmail: 'mail@example.com',
      apiKeyCiphertext: 'encrypted:15',
      apiKeyIv: 'unique-iv',
      apiKeyLast4: 'cret',
    });
    expect(publicSettings).toMatchObject({ apiKeyConfigured: true, apiKeyMask: '••••cret' });
    expect(publicSettings).not.toHaveProperty('apiKey');

    const internalSettings = await getAccountEmailSettings();
    expect(internalSettings.apiKey).toBe('re_super_secret');
    expect(internalSettings).not.toHaveProperty('apiKeyCiphertext');
    expect(internalSettings).not.toHaveProperty('apiKeyIv');
  });

  test('removing the key also disables account email delivery', async () => {
    await updateAccountEmailSettings({
      senderEmail: 'mail@example.com',
      apiKey: 're_super_secret',
      enabled: true,
    });
    await expect(updateAccountEmailSettings({ apiKey: null })).resolves.toMatchObject({
      enabled: false,
      apiKeyConfigured: false,
      apiKeyMask: null,
    });
  });
});
