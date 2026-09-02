import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { db } from '@openreader/database';
import { adminProviders } from '@openreader/database/schema';
import * as adminProviderModule from '@/lib/server/admin/providers';
import { createAdminProvider } from '@/lib/server/admin/providers';
import { serverLogger } from '@/lib/server/logger';
import { POST } from '@/app/api/internal/compute/tts-credentials/route';

const BROKER_TOKEN = 'unit-credential-broker-token';
const createdProviderIds: string[] = [];
let previousBrokerToken: string | undefined;

function brokerRequest(body: unknown, token: string | null = BROKER_TOKEN): NextRequest {
  return new NextRequest('http://localhost/api/internal/compute/tts-credentials', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

async function createFixtureProvider(input?: { enabled?: boolean; apiKey?: string }) {
  const suffix = randomUUID().replace(/-/g, '');
  const provider = await createAdminProvider({
    slug: `broker-${suffix}`,
    displayName: 'Broker fixture',
    providerType: 'custom-openai',
    baseUrl: 'https://tts.internal.example/v1',
    apiKey: input?.apiKey ?? 'broker-api-key-sentinel',
    defaultModel: 'gpt-4o-mini-tts',
    defaultInstructions: 'Read clearly.',
    enabled: input?.enabled ?? true,
  });
  createdProviderIds.push(provider.id);
  return provider;
}

describe('TTS credential broker route', () => {
  beforeEach(() => {
    previousBrokerToken = process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN;
    process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN = BROKER_TOKEN;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousBrokerToken === undefined) delete process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN;
    else process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN = previousBrokerToken;
    if (createdProviderIds.length > 0) {
      await db.delete(adminProviders).where(inArray(adminProviders.id, createdProviderIds.splice(0)));
    }
  });

  test('rejects unauthenticated requests before provider resolution', async () => {
    const log = vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
    const missing = await POST(brokerRequest({ providerRef: 'not-configured' }, null));
    const incorrectToken = 'incorrect-token-must-not-be-logged';
    const incorrect = await POST(brokerRequest({ providerRef: 'not-configured' }, incorrectToken));

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'BROKER_UNAUTHORIZED' });
    expect(incorrect.status).toBe(401);
    expect(await incorrect.json()).toEqual({ error: 'BROKER_UNAUTHORIZED' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(incorrectToken);
  });

  test('fails closed when the broker token is not configured', async () => {
    delete process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN;
    const response = await POST(brokerRequest({ providerRef: 'not-configured' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'BROKER_UNAVAILABLE' });
  });

  test('rejects malformed provider references', async () => {
    const response = await POST(brokerRequest({ providerRef: '../admin_providers' }));
    const injected = await POST(brokerRequest({
      providerRef: 'openai',
      apiKey: 'must-not-be-accepted',
    }));
    const oversized = await POST(brokerRequest({ providerRef: `a${'b'.repeat(1_024)}` }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'PROVIDER_REF_INVALID' });
    expect(injected.status).toBe(400);
    expect(await injected.json()).toEqual({ error: 'PROVIDER_REF_INVALID' });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toEqual({ error: 'PROVIDER_REF_INVALID' });
  });

  test('returns v4-compatible decrypted execution configuration without caching it', async () => {
    const provider = await createFixtureProvider();
    const response = await POST(brokerRequest({ providerRef: provider.slug.toUpperCase() }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({
      providerRef: provider.slug,
      providerType: 'custom-openai',
      apiKey: 'broker-api-key-sentinel',
      baseUrl: 'https://tts.internal.example/v1',
      defaultModel: 'gpt-4o-mini-tts',
      defaultInstructions: 'Read clearly.',
    });
  });

  test('does not return credentials for disabled providers', async () => {
    const provider = await createFixtureProvider({ enabled: false });
    const response = await POST(brokerRequest({ providerRef: provider.slug }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'PROVIDER_UNAVAILABLE' });
  });

  test('returns a stable redacted decryption failure', async () => {
    const provider = await createFixtureProvider({ apiKey: 'must-never-appear-in-the-error' });
    await db.update(adminProviders)
      .set({ apiKeyCiphertext: 'invalid-ciphertext' })
      .where(eq(adminProviders.id, provider.id));
    const log = vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);

    const response = await POST(brokerRequest({ providerRef: provider.slug }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'PROVIDER_DECRYPT_FAILED' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('must-never-appear-in-the-error');
    expect(JSON.stringify(log.mock.calls)).not.toContain('invalid-ciphertext');
  });

  test('maps an unavailable app database to a stable redacted response', async () => {
    const failureSentinel = 'database-detail-must-not-leak';
    vi.spyOn(adminProviderModule, 'getEnabledAdminProviderBySlug')
      .mockRejectedValueOnce(new Error(failureSentinel));
    const log = vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);

    const response = await POST(brokerRequest({ providerRef: 'missing-provider' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'BROKER_UNAVAILABLE' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(failureSentinel);
  });
});
