import { expect, test } from '@playwright/test';

import {
  AdminProviderError,
  toMasked,
  validateProviderType,
  validateSlug,
  type AdminProviderRecord,
} from '../../src/lib/server/admin/providers';

test.describe('admin provider validation', () => {
  test('normalizes valid slugs to lowercase', () => {
    expect(validateSlug('My-Provider-1')).toBe('my-provider-1');
  });

  test('rejects built-in provider ids as slugs', () => {
    expect(() => validateSlug('openai')).toThrow(AdminProviderError);
    expect(() => validateSlug('custom-openai')).toThrow('reserved');
  });

  test('rejects malformed slug values', () => {
    expect(() => validateSlug('-bad-')).toThrow(AdminProviderError);
    expect(() => validateSlug('bad_slug')).toThrow(AdminProviderError);
    expect(() => validateSlug('')).toThrow(AdminProviderError);
  });

  test('accepts only known provider types', () => {
    expect(validateProviderType('openai')).toBe('openai');
    expect(() => validateProviderType('unknown')).toThrow(AdminProviderError);
  });

  test('masks api key from last4 in list responses', () => {
    const record: AdminProviderRecord = {
      id: 'id-1',
      slug: 'shared-one',
      displayName: 'Shared One',
      providerType: 'openai',
      baseUrl: null,
      apiKeyCiphertext: 'ciphertext',
      apiKeyIv: 'iv',
      apiKeyLast4: 'abcd',
      defaultModel: 'gpt-4o-mini-tts',
      defaultInstructions: 'warm tone',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    expect(toMasked(record).apiKeyMask).toBe('••••abcd');
  });
});

