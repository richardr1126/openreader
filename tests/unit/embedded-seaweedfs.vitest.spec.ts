import { CreateBucketCommand, HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import {
  ensureS3Bucket,
  reconcileWeedMiniKek,
  resolveWeedMiniAdvertiseHost,
  resolveWeedMiniInternalPorts,
  unwrapWeedFilerKek,
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

  test('moves taken ports with their gRPC partner, never onto a reserved or already chosen port', async () => {
    const taken = new Set([8888, 33646, 50002 + 10000]);
    const free = [8081, 60000, 50001, 50002, 50003];
    const ports = Object.fromEntries(await resolveWeedMiniInternalPorts(dataDir(), '127.0.0.1', {
      reserved: [8081],
      isFree: async (port) => !taken.has(port),
      pickFree: async () => free.shift()!,
    }));
    expect(ports['master.port']).toBe(9333);
    expect(ports['filer.port']).toBe(50001);
    expect(ports['admin.port']).toBe(50003);
    for (const key of ['master', 'filer', 'volume', 'admin']) {
      expect(ports[`${key}.port.grpc`]).toBe(ports[`${key}.port`] + 10000);
    }
    expect(new Set(Object.values(ports)).size).toBe(Object.keys(ports).length);
  });

  test('re-pairs gRPC ports persisted apart from their HTTP port, keeping the HTTP ports', async () => {
    const dir = dataDir('master.port=55368\nmaster.port.grpc=55369\nadmin.port=55375\nadmin.port.grpc=55376\n');
    const ports = Object.fromEntries(await resolveWeedMiniInternalPorts(dir, '127.0.0.1', { isFree: async () => true }));
    expect(ports['master.port']).toBe(55368);
    expect(ports['master.port.grpc']).toBe(65368);
    expect(ports['admin.port']).toBe(55375);
    expect(ports['admin.port.grpc']).toBe(65375);
  });

  test('pairs the S3 gRPC port with the configured S3 port', async () => {
    const ports = Object.fromEntries(await resolveWeedMiniInternalPorts(dataDir(), '127.0.0.1', {
      s3Port: 9000,
      isFree: async () => true,
    }));
    expect(ports['s3.port.grpc']).toBe(19000);
  });

  test('turns off components OpenReader never uses, including the admin UI', () => {
    expect(WEED_MINI_DISABLED_COMPONENTS).toEqual(['-webdav=false', '-s3.port.iceberg=0', '-admin.ui=false']);
  });
});

describe('weed mini SSE-S3 key', () => {
  const filerKek = 'ab'.repeat(32);
  const miniKek = 'cd'.repeat(32);
  const passphrase = 'ef'.repeat(32);
  const filerUrl = 'http://127.0.0.1:8888';
  const filer = (body: string, status = 200) => vi.fn(async () => (
    new Response(body, { status })
  )) as unknown as typeof fetch;
  const dataDir = (key = miniKek) => {
    const dir = mkdtempSync(join(tmpdir(), 'weed-kek-'));
    writeFileSync(join(dir, '.mini_sse_kek'), key);
    writeFileSync(join(dir, '.mini_kek_passphrase'), passphrase);
    return dir;
  };
  // The format weed stores once it has a passphrase: base64(SWv2 || salt || nonce || ciphertext+tag).
  const wrap = (kek: string, secret = passphrase) => {
    const salt = randomBytes(32);
    const nonce = randomBytes(12);
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret), salt, Buffer.from('kek-wrapping'), 32));
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const sealed = Buffer.concat([cipher.update(Buffer.from(kek, 'hex')), cipher.final(), cipher.getAuthTag()]);
    return Buffer.concat([Buffer.from('SWv2'), salt, nonce, sealed]).toString('base64');
  };
  const keyIn = (dir: string) => readFileSync(join(dir, '.mini_sse_kek'), 'utf8');

  test('unwraps a key the way weed wraps it', () => {
    expect(unwrapWeedFilerKek(wrap(filerKek), passphrase)).toBe(filerKek);
    expect(() => unwrapWeedFilerKek(wrap(filerKek), 'other')).toThrow();
  });

  test("restores the filer's key after weed wrapped it under a key of its own", async () => {
    const dir = dataDir();
    await expect(reconcileWeedMiniKek(dir, filerUrl, {}, filer(wrap(filerKek)))).resolves.toBe(true);
    expect(keyIn(dir)).toBe(filerKek);
    if (process.platform !== 'win32') expect(statSync(join(dir, '.mini_sse_kek')).mode & 0o777).toBe(0o600);
  });

  test("restores a filer key still stored in plaintext by an older weed", async () => {
    const dir = dataDir();
    await expect(reconcileWeedMiniKek(dir, filerUrl, {}, filer(`${filerKek}\n`))).resolves.toBe(true);
    expect(keyIn(dir)).toBe(filerKek);
  });

  test('changes nothing when the keys already agree or the filer has none', async () => {
    const dir = dataDir(filerKek);
    await expect(reconcileWeedMiniKek(dir, filerUrl, {}, filer(wrap(filerKek)))).resolves.toBe(false);
    await expect(reconcileWeedMiniKek(dir, filerUrl, {}, filer('', 404))).resolves.toBe(false);
    expect(keyIn(dir)).toBe(filerKek);
  });

  test('leaves an operator-supplied key alone', async () => {
    const dir = dataDir();
    const fetchImpl = filer(wrap(filerKek));
    await expect(reconcileWeedMiniKek(dir, filerUrl, { WEED_S3_SSE_KEK: miniKek }, fetchImpl)).resolves.toBe(false);
    await expect(reconcileWeedMiniKek(dir, filerUrl, { WEED_S3_SSE_KEK_PASSPHRASE: 'x' }, fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(keyIn(dir)).toBe(miniKek);
  });

  test('refuses a filer key it cannot read without touching the local key', async () => {
    const dir = dataDir();
    await expect(reconcileWeedMiniKek(dir, filerUrl, {}, filer('d3JhcHBlZA==')))
      .rejects.toThrow(/unknown format.*No stored data was changed/);
    await expect(reconcileWeedMiniKek(dir, filerUrl, {}, filer(wrap(filerKek, 'other'))))
      .rejects.toThrow(/No stored data was changed/);
    expect(keyIn(dir)).toBe(miniKek);
  });
});
