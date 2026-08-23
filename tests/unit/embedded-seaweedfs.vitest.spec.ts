import { CreateBucketCommand, HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, test, vi } from 'vitest';

import {
  ensureS3Bucket,
  resolveWeedMiniAdvertiseHost,
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
