import { CreateBucketCommand, HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import {
  adoptWeedMiniFilerKek,
  ensureS3Bucket,
  needsWeedMiniKekAdoption,
  resolveWeedMiniAdvertiseHost,
  resolveWeedMiniInternalPorts,
  WEED_MINI_DISABLED_COMPONENTS,
} from '../../packages/bootstrap/src/embedded-seaweedfs.mjs';

const embeddedS3Env = {
  S3_BUCKET: 'openreader-documents',
  S3_REGION: 'us-east-1',
  S3_INTERNAL_ENDPOINT: 'http://127.0.0.1:8333',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

describe('embedded SeaweedFS addressing', () => {
  test('advertises the loopback address used by the default bind', () => {
    expect(resolveWeedMiniAdvertiseHost('127.0.0.1', undefined, '192.168.0.151')).toBe('127.0.0.1');
  });

  test('uses the detected host when binding all interfaces', () => {
    expect(resolveWeedMiniAdvertiseHost('0.0.0.0', undefined, '192.168.0.151')).toBe('192.168.0.151');
  });

  test('honors an explicit advertised hostname', () => {
    expect(resolveWeedMiniAdvertiseHost('0.0.0.0', 'storage.reader.test', '192.168.0.151'))
      .toBe('storage.reader.test');
  });

  test('keeps an existing embedded bucket', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;

    await expect(ensureS3Bucket(embeddedS3Env, client)).resolves.toEqual({
      bucket: 'openreader-documents',
      created: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
  });

  test('creates a missing embedded bucket', async () => {
    const missingBucket = Object.assign(new Error('missing'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const send = vi.fn()
      .mockRejectedValueOnce(missingBucket)
      .mockResolvedValueOnce({});
    const client = { send } as unknown as S3Client;

    await expect(ensureS3Bucket(embeddedS3Env, client)).resolves.toEqual({
      bucket: 'openreader-documents',
      created: true,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(CreateBucketCommand);
  });

  test('does not hide unexpected embedded storage errors', async () => {
    const storageFailure = new Error('connection reset');
    const send = vi.fn().mockRejectedValue(storageFailure);
    const client = { send } as unknown as S3Client;

    await expect(ensureS3Bucket(embeddedS3Env, client)).rejects.toBe(storageFailure);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('embedded SeaweedFS internal ports', () => {
  function dataDir(options?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'weed-ports-'));
    if (options !== undefined) writeFileSync(join(dir, 'mini.options'), options);
    return dir;
  }

  test('uses mini defaults on a fresh data directory when they are free', async () => {
    const ports = await resolveWeedMiniInternalPorts(dataDir(), '127.0.0.1', { isFree: async () => true });
    expect(Object.fromEntries(ports)).toEqual({
      'master.port': 9333,
      'master.port.grpc': 19333,
      'filer.port': 8888,
      'filer.port.grpc': 18888,
      'volume.port': 9340,
      'volume.port.grpc': 19340,
      's3.port.grpc': 18333,
      'admin.port': 23646,
      'admin.port.grpc': 33646,
    });
  });

  test('keeps the ports weed persisted', async () => {
    const dir = dataDir('# Mini server configuration\nmaster.port=41001\nfiler.port = 41003\nip=127.0.0.1\n');
    const ports = Object.fromEntries(await resolveWeedMiniInternalPorts(dir, '127.0.0.1', { isFree: async () => true }));
    expect(ports['master.port']).toBe(41001);
    expect(ports['filer.port']).toBe(41003);
    expect(ports['volume.port']).toBe(9340);
  });

  test('moves only taken ports, never onto a reserved or already chosen port', async () => {
    const taken = new Set([8888, 23646]);
    const free = [8081, 50001, 50002];
    const ports = Object.fromEntries(await resolveWeedMiniInternalPorts(dataDir(), '127.0.0.1', {
      reserved: [8081],
      isFree: async (port) => !taken.has(port),
      pickFree: async () => free.shift()!,
    }));
    expect(ports['master.port']).toBe(9333);
    expect(ports['filer.port']).toBe(50001);
    expect(ports['admin.port']).toBe(50002);
    expect(new Set(Object.values(ports)).size).toBe(Object.keys(ports).length);
  });

  test('turns off components OpenReader never uses, including the admin UI', () => {
    expect(WEED_MINI_DISABLED_COMPONENTS).toEqual(['-webdav=false', '-s3.port.iceberg=0', '-admin.ui=false']);
  });
});

describe('weed mini SSE-S3 key upgrade', () => {
  const filerKek = 'ab'.repeat(32);
  const dataDir = () => mkdtempSync(join(tmpdir(), 'weed-kek-'));
  // The filer answers its root (readiness) and then the key path.
  const filer = (kekResponse: Response) => vi.fn(async (url: string) => (
    url.endsWith('/etc/s3/sse_kek') ? kekResponse : new Response('')
  )) as unknown as typeof fetch;

  test('adopts only for a data directory that weed ran in before keeping its own key', () => {
    const fresh = dataDir();
    expect(needsWeedMiniKekAdoption(fresh)).toBe(false);

    writeFileSync(join(fresh, 'mini.options'), 'filer.port=8888\n');
    expect(needsWeedMiniKekAdoption(fresh)).toBe(true);
    expect(needsWeedMiniKekAdoption(fresh, { WEED_S3_SSE_KEK: filerKek })).toBe(false);

    writeFileSync(join(fresh, '.mini_sse_kek'), filerKek);
    expect(needsWeedMiniKekAdoption(fresh)).toBe(false);
  });

  test('writes the filer key over the key mini generated', async () => {
    const dir = dataDir();
    writeFileSync(join(dir, '.mini_sse_kek'), 'cd'.repeat(32));

    await expect(adoptWeedMiniFilerKek(dir, 'http://127.0.0.1:8888', {
      fetchImpl: filer(new Response(`${filerKek}\n`)),
    })).resolves.toBe(true);
    expect(readFileSync(join(dir, '.mini_sse_kek'), 'utf8')).toBe(filerKek);
    if (process.platform !== 'win32') expect(statSync(join(dir, '.mini_sse_kek')).mode & 0o777).toBe(0o600);
  });

  test("keeps mini's key when the filer never stored one", async () => {
    const dir = dataDir();
    writeFileSync(join(dir, '.mini_sse_kek'), 'cd'.repeat(32));

    await expect(adoptWeedMiniFilerKek(dir, 'http://127.0.0.1:8888', {
      fetchImpl: filer(new Response('', { status: 404 })),
    })).resolves.toBe(false);
    expect(readFileSync(join(dir, '.mini_sse_kek'), 'utf8')).toBe('cd'.repeat(32));
  });

  test("discards mini's key when the filer key cannot be carried forward", async () => {
    const dir = dataDir();
    writeFileSync(join(dir, '.mini_sse_kek'), 'cd'.repeat(32));

    await expect(adoptWeedMiniFilerKek(dir, 'http://127.0.0.1:8888', {
      fetchImpl: filer(new Response('d3JhcHBlZA==')),
    })).rejects.toThrow(/not a plaintext 32-byte hex key.*No stored data was changed/);
    expect(existsSync(join(dir, '.mini_sse_kek'))).toBe(false);
  });
});
