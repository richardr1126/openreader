import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  getPublicAccountEmailSettings: vi.fn(),
  updateAccountEmailSettings: vi.fn(),
}));

vi.mock('@/lib/server/auth/admin', () => ({ requireAdminContext: mocks.requireAdminContext }));
vi.mock('@/lib/server/admin/email-settings', () => ({
  AccountEmailSettingsError: class AccountEmailSettingsError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
  },
  getPublicAccountEmailSettings: mocks.getPublicAccountEmailSettings,
  updateAccountEmailSettings: mocks.updateAccountEmailSettings,
}));

import { GET, PATCH } from '../../src/app/api/admin/email/route';

describe('admin email settings route', () => {
  beforeEach(() => {
    mocks.requireAdminContext.mockReset();
    mocks.requireAdminContext.mockResolvedValue({ userId: 'admin-1' });
    mocks.getPublicAccountEmailSettings.mockReset();
    mocks.getPublicAccountEmailSettings.mockResolvedValue({ enabled: false });
    mocks.updateAccountEmailSettings.mockReset();
    mocks.updateAccountEmailSettings.mockResolvedValue({ enabled: true });
  });

  test('returns the authorization response before reading settings', async () => {
    const denied = new Response('Forbidden', { status: 403 });
    mocks.requireAdminContext.mockResolvedValue(denied);

    const response = await GET(new NextRequest('http://localhost/api/admin/email'));

    expect(response).toBe(denied);
    expect(mocks.getPublicAccountEmailSettings).not.toHaveBeenCalled();
  });

  test('rejects unknown fields before writing settings', async () => {
    const response = await PATCH(new NextRequest('http://localhost/api/admin/email', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 're_secret', exposeKey: true }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Unknown field: exposeKey' });
    expect(mocks.updateAccountEmailSettings).not.toHaveBeenCalled();
  });
});
