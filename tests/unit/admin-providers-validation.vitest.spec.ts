import { describe, expect, test } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '@openreader/database';
import { adminProviders } from '@openreader/database/schema';

import {
  AdminProviderError,
  createAdminProvider,
  decryptedKeyFor,
  listAdminProviders,
  toMasked,
  updateAdminProvider,
  validateProviderType,
  validateSlug,
  type AdminProviderRecord,
} from '../../src/lib/server/admin/providers';

describe('admin provider validation', () => {
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
      defaultModelOptions: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    expect(toMasked(record).apiKeyMask).toBe('••••abcd');
  });

  test('creates providers without an API key', async () => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const created = await createAdminProvider({
      slug: `keyless-${suffix}`,
      displayName: 'Keyless Provider',
      providerType: 'custom-openai',
      baseUrl: 'http://localhost:8880/v1',
    });

    try {
      expect(toMasked(created).apiKeyMask).toBe('(not set)');
      await expect(decryptedKeyFor(created)).resolves.toBe('');
    } finally {
      await db.delete(adminProviders).where(inArray(adminProviders.id, [created.id]));
    }
  });

  test('checks default instructions against the provider type', async () => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const created = await createAdminProvider({
      slug: `router-${suffix}`,
      displayName: 'OpenRouter',
      providerType: 'openrouter',
      defaultModel: 'fish-audio/s2.1-pro-free:free',
      defaultInstructions: 'warm tone',
    });

    try {
      expect(created.defaultInstructions).toBe('warm tone');
      await expect(createAdminProvider({
        slug: `router-plain-${suffix}`,
        displayName: 'OpenRouter',
        providerType: 'openrouter',
        defaultModel: 'mistralai/voxtral-mini-tts-2603',
        defaultInstructions: 'warm tone',
      })).rejects.toThrow('defaultInstructions is only supported');
    } finally {
      await db.delete(adminProviders).where(inArray(adminProviders.id, [created.id]));
    }
  });

  test('stores OpenRouter model options bound to the default model and clears them when it changes', async () => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const created = await createAdminProvider({
      slug: `router-options-${suffix}`,
      displayName: 'OpenRouter',
      providerType: 'openrouter',
      defaultModel: 'fish-audio/s2.1-pro-free:free',
      defaultModelOptions: '{"provider":{"options":{"fish-audio":{"top_p":0.5,"temperature":0.4}}}}',
    });

    try {
      expect(JSON.parse(created.defaultModelOptions ?? '')).toEqual({
        model: 'fish-audio/s2.1-pro-free:free',
        provider: { options: { 'fish-audio': { temperature: 0.4, top_p: 0.5 } } },
      });
      await expect(updateAdminProvider(created.id, { defaultModelOptions: '{"provider":' }))
        .rejects.toThrow('valid JSON');
      await expect(updateAdminProvider(created.id, { defaultModelOptions: '{"api_key":"x"}' }))
        .rejects.toThrow(AdminProviderError);
      const moved = await updateAdminProvider(created.id, { defaultModel: 'openai/gpt-4o-mini-tts' });
      expect(moved.defaultModelOptions).toBeNull();
    } finally {
      await db.delete(adminProviders).where(inArray(adminProviders.id, [created.id]));
    }
  });

  test('lists providers in deterministic updated/created/slug order', async () => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const inserted = [
      {
        id: `prov-aaa-${suffix}`,
        slug: `ord-aaa-${suffix}`,
        displayName: 'Order AAA',
        providerType: 'openai' as const,
        baseUrl: null,
        apiKeyCiphertext: 'cipher',
        apiKeyIv: 'iv',
        apiKeyLast4: '1111',
        defaultModel: null,
        defaultInstructions: null,
        enabled: 1,
        createdAt: 200,
        updatedAt: 300,
      },
      {
        id: `prov-zzz-${suffix}`,
        slug: `ord-zzz-${suffix}`,
        displayName: 'Order ZZZ',
        providerType: 'openai' as const,
        baseUrl: null,
        apiKeyCiphertext: 'cipher',
        apiKeyIv: 'iv',
        apiKeyLast4: '2222',
        defaultModel: null,
        defaultInstructions: null,
        enabled: 1,
        createdAt: 200,
        updatedAt: 300,
      },
      {
        id: `prov-mid-${suffix}`,
        slug: `ord-mid-${suffix}`,
        displayName: 'Order MID',
        providerType: 'openai' as const,
        baseUrl: null,
        apiKeyCiphertext: 'cipher',
        apiKeyIv: 'iv',
        apiKeyLast4: '3333',
        defaultModel: null,
        defaultInstructions: null,
        enabled: 1,
        createdAt: 150,
        updatedAt: 300,
      },
      {
        id: `prov-old-${suffix}`,
        slug: `ord-old-${suffix}`,
        displayName: 'Order OLD',
        providerType: 'openai' as const,
        baseUrl: null,
        apiKeyCiphertext: 'cipher',
        apiKeyIv: 'iv',
        apiKeyLast4: '4444',
        defaultModel: null,
        defaultInstructions: null,
        enabled: 1,
        createdAt: 999,
        updatedAt: 200,
      },
    ];

    try {
      await db.insert(adminProviders).values(inserted);
      const listed = await listAdminProviders();
      const ordered = listed
        .filter((row) => row.slug.endsWith(suffix))
        .map((row) => row.slug);

      expect(ordered).toEqual([
        `ord-aaa-${suffix}`,
        `ord-zzz-${suffix}`,
        `ord-mid-${suffix}`,
        `ord-old-${suffix}`,
      ]);
    } finally {
      await db.delete(adminProviders).where(inArray(adminProviders.id, inserted.map((row) => row.id)));
    }
  });
});
