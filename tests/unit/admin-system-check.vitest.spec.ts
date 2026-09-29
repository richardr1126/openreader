import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  runSystemCheck: vi.fn(),
  isS3Configured: vi.fn(),
}));

vi.mock('@/lib/server/auth/admin', () => ({ requireAdminContext: mocks.requireAdminContext }));
vi.mock('@/lib/server/admin/providers', () => ({ listEnabledAdminProviders: vi.fn() }));
vi.mock('@/lib/server/storage/s3', () => ({
  getS3Config: () => ({ bucket: 'openreader-documents' }),
  getS3InternalClient: vi.fn(),
  isS3Configured: mocks.isS3Configured,
}));

import { runSystemCheck as realRunSystemCheck } from '../../src/lib/server/admin/system-check';
import {
  evaluateBrowserChecks,
  isBlockedMixedContent,
} from '../../src/lib/shared/system-check';

const okDeps = {
  env: { BASE_URL: 'http://localhost:3003', TTS_PLAYBACK_TOKEN_SECRET: 'secret' },
  probeWorker: vi.fn(),
  probeStorage: vi.fn(),
  countEnabledProviders: vi.fn(),
};

const byId = (report: Awaited<ReturnType<typeof realRunSystemCheck>>, id: string) => {
  const item = report.checks.find((check) => check.id === id);
  if (!item) throw new Error(`missing check ${id}`);
  return item;
};

describe('server system check', () => {
  const previousEnv = { url: process.env.COMPUTE_WORKER_URL, token: process.env.COMPUTE_WORKER_TOKEN, publicUrl: process.env.COMPUTE_WORKER_PUBLIC_URL };

  beforeEach(() => {
    process.env.COMPUTE_WORKER_URL = 'http://127.0.0.1:8081';
    process.env.COMPUTE_WORKER_TOKEN = 'worker-token';
    delete process.env.COMPUTE_WORKER_PUBLIC_URL;
    mocks.isS3Configured.mockReturnValue(true);
    okDeps.probeWorker.mockReset().mockResolvedValue(undefined);
    okDeps.probeStorage.mockReset().mockResolvedValue(undefined);
    okDeps.countEnabledProviders.mockReset().mockResolvedValue(1);
  });

  afterEach(() => {
    for (const [key, value] of [['COMPUTE_WORKER_URL', previousEnv.url], ['COMPUTE_WORKER_TOKEN', previousEnv.token], ['COMPUTE_WORKER_PUBLIC_URL', previousEnv.publicUrl]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('reports a healthy instance and the addresses the browser must probe', async () => {
    const report = await realRunSystemCheck(okDeps);

    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ['worker', 'ok'],
      ['storage', 'ok'],
      ['playback-secret', 'ok'],
      ['providers', 'ok'],
    ]);
    expect(report.baseUrl).toBe('http://localhost:3003');
    expect(report.workerPublicUrl).toBe('http://127.0.0.1:8081');
    expect(okDeps.probeWorker).toHaveBeenCalledWith('http://127.0.0.1:8081');
  });

  test('turns each failing dependency into an actionable item instead of throwing', async () => {
    okDeps.probeWorker.mockRejectedValue(new Error('connect ECONNREFUSED'));
    okDeps.probeStorage.mockRejectedValue(new Error('NoSuchBucket'));
    okDeps.countEnabledProviders.mockResolvedValue(0);

    const report = await realRunSystemCheck({ ...okDeps, env: { BASE_URL: 'http://localhost:3003' } });

    expect(byId(report, 'worker')).toMatchObject({ status: 'error', detail: expect.stringContaining('ECONNREFUSED') });
    expect(byId(report, 'storage')).toMatchObject({ status: 'error', detail: expect.stringContaining('NoSuchBucket') });
    expect(byId(report, 'playback-secret')).toMatchObject({ status: 'error', fix: expect.stringContaining('openssl rand') });
    expect(byId(report, 'providers')).toMatchObject({ status: 'warn', fix: expect.stringContaining('Providers') });
  });

  test('reports missing worker and storage configuration without probing', async () => {
    delete process.env.COMPUTE_WORKER_URL;
    mocks.isS3Configured.mockReturnValue(false);

    const report = await realRunSystemCheck(okDeps);

    expect(byId(report, 'worker').status).toBe('error');
    expect(byId(report, 'storage').status).toBe('error');
    expect(okDeps.probeWorker).not.toHaveBeenCalled();
    expect(okDeps.probeStorage).not.toHaveBeenCalled();
    expect(report.workerPublicUrl).toBeNull();
  });
});

describe('admin system check route', () => {
  test('returns the authorization response before running any check', async () => {
    vi.resetModules();
    vi.doMock('@/lib/server/admin/system-check', () => ({ runSystemCheck: mocks.runSystemCheck }));
    const denied = new Response('Forbidden', { status: 403 });
    mocks.requireAdminContext.mockResolvedValue(denied);
    const { GET } = await import('../../src/app/api/admin/system-check/route');

    const response = await GET(new NextRequest('http://localhost/api/admin/system-check'));

    expect(response).toBe(denied);
    expect(mocks.runSystemCheck).not.toHaveBeenCalled();
    vi.doUnmock('@/lib/server/admin/system-check');
  });
});

describe('browser system check', () => {
  const base = { pageOrigin: 'http://localhost:3003', baseUrl: 'http://localhost:3003', workerPublicUrl: 'http://localhost:8081' };

  test('confirms matching addresses and a reachable worker', () => {
    const items = evaluateBrowserChecks({ ...base, workerProbe: 'reachable' });
    expect(items.map((item) => [item.id, item.status])).toEqual([['base-url', 'ok'], ['worker-public-url', 'ok']]);
  });

  test('warns when the page was opened at an address other than BASE_URL', () => {
    const [item] = evaluateBrowserChecks({ ...base, pageOrigin: 'http://192.168.0.20:3003', workerProbe: 'reachable' });
    expect(item).toMatchObject({ id: 'base-url', status: 'warn', fix: expect.stringContaining('AUTH_TRUSTED_ORIGINS') });
  });

  test('flags an unreachable worker with the port and public URL fix', () => {
    const item = evaluateBrowserChecks({ ...base, workerProbe: 'unreachable' }).find((entry) => entry.id === 'worker-public-url');
    expect(item).toMatchObject({ status: 'error', fix: expect.stringContaining('COMPUTE_WORKER_PUBLIC_URL') });
  });

  test('flags https pages loading http audio as blocked before probing', () => {
    const items = evaluateBrowserChecks({
      pageOrigin: 'https://reader.example.com',
      baseUrl: 'https://reader.example.com',
      workerPublicUrl: 'http://reader.example.com:8081',
      workerProbe: 'reachable',
    });
    expect(items.find((entry) => entry.id === 'worker-public-url')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('mixed content'),
    });
  });

  test('treats loopback http as allowed from an https page', () => {
    expect(isBlockedMixedContent(new URL('https://reader.example.com'), new URL('http://localhost:8081'))).toBe(false);
    expect(isBlockedMixedContent(new URL('https://reader.example.com'), new URL('http://10.0.0.5:8081'))).toBe(true);
    expect(isBlockedMixedContent(new URL('http://reader.example.com'), new URL('http://10.0.0.5:8081'))).toBe(false);
  });

  test('omits browser checks that have nothing to compare', () => {
    expect(evaluateBrowserChecks({ pageOrigin: 'http://localhost:3003', baseUrl: null, workerPublicUrl: null, workerProbe: null })).toEqual([]);
  });
});
