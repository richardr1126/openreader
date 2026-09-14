import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  decryptSecret: vi.fn(),
  getAccountEmailSettings: vi.fn(),
}));

vi.mock('@/lib/server/crypto/secrets', () => ({ decryptSecret: mocks.decryptSecret }));
vi.mock('@/lib/server/admin/email-settings', () => ({ getAccountEmailSettings: mocks.getAccountEmailSettings }));

import { POST } from '@/app/api/internal/compute/email-execution/route';

const TOKEN = 'email-broker-test-token';
const deliveryId = '54f60fb9-e895-4c1c-9968-9d27ebbd9c31';

function request(body: unknown, token: string | null = TOKEN): NextRequest {
  return new NextRequest('http://localhost/api/internal/compute/email-execution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function payload(expiresAt = Date.now() + 60_000) {
  return {
    deliveryId,
    purpose: 'email_verification',
    envelopeCiphertext: 'ciphertext',
    envelopeIv: 'iv-value',
    expiresAt,
  };
}

function envelope(expiresAt: number, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    deliveryId,
    purpose: 'email_verification',
    recipient: 'reader@example.com',
    actionUrl: 'https://reader.example/api/auth/verify-email?token=secret',
    senderName: 'OpenReader',
    senderEmail: 'mail@example.com',
    replyTo: null,
    expiresAt,
    allowWhenDisabled: false,
    ...overrides,
  };
}

describe('email execution broker route', () => {
  beforeEach(() => {
    process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN = TOKEN;
    mocks.getAccountEmailSettings.mockResolvedValue({ enabled: true, apiKey: 're_secret' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN;
  });

  test('rejects unauthenticated requests before decryption', async () => {
    const response = await POST(request(payload(), null));
    expect(response.status).toBe(401);
    expect(mocks.decryptSecret).not.toHaveBeenCalled();
  });

  test('rejects tampered and expired envelopes', async () => {
    mocks.decryptSecret.mockImplementationOnce(() => { throw new Error('auth tag mismatch'); });
    expect((await POST(request(payload()))).status).toBe(400);

    const expiresAt = Date.now() - 1;
    mocks.decryptSecret.mockReturnValueOnce(JSON.stringify(envelope(expiresAt)));
    expect((await POST(request(payload(expiresAt)))).status).toBe(410);
  });

  test('prevents queued account mail after the feature is disabled', async () => {
    const expiresAt = Date.now() + 60_000;
    mocks.decryptSecret.mockReturnValue(JSON.stringify(envelope(expiresAt)));
    mocks.getAccountEmailSettings.mockResolvedValue({ enabled: false, apiKey: 're_secret' });
    const response = await POST(request(payload(expiresAt)));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'ACCOUNT_EMAILS_DISABLED' });
  });

  test('returns execution data without cacheability', async () => {
    const expiresAt = Date.now() + 60_000;
    mocks.decryptSecret.mockReturnValue(JSON.stringify(envelope(expiresAt)));
    const response = await POST(request(payload(expiresAt)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(await response.json()).toEqual(expect.objectContaining({
      apiKey: 're_secret',
      deliveryId,
      to: 'reader@example.com',
    }));
  });
});
