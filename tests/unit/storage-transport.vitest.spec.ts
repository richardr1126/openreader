import { describe, expect, test } from 'vitest';
import { resolveStorageTransport } from '../../packages/bootstrap/src/storage-transport.mjs';

const base = {
  S3_INTERNAL_ENDPOINT: 'http://seaweedfs:8333',
  S3_BUCKET: 'bucket',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

function resolve(env: Record<string, string>): ReturnType<typeof resolveStorageTransport> {
  return resolveStorageTransport(env as NodeJS.ProcessEnv);
}

describe('storage transport resolution', () => {
  test('uses same-origin proxy delivery for embedded auto mode', () => {
    expect(resolve({ ...base, USE_EMBEDDED_WEED_MINI: 'true' })).toMatchObject({
      mode: 'proxy',
      internalEndpoint: 'http://seaweedfs:8333',
      publicEndpoint: undefined,
    });
  });

  test('uses the public HTTPS endpoint only for presigned browser transfers', () => {
    expect(resolve({ ...base, USE_EMBEDDED_WEED_MINI: 'false', S3_PUBLIC_ENDPOINT: 'https://s3.reader.example' })).toMatchObject({
      mode: 'presigned',
      internalEndpoint: 'http://seaweedfs:8333',
      publicEndpoint: 'https://s3.reader.example',
    });
  });

  test('rejects an ambiguous external auto configuration and cloud proxy delivery', () => {
    expect(() => resolve({ ...base, USE_EMBEDDED_WEED_MINI: 'false' })).toThrow('S3_PUBLIC_ENDPOINT');
    expect(() => resolve({ ...base, S3_BROWSER_TRANSPORT: 'proxy', VERCEL: '1' })).toThrow('not supported on Vercel');
    expect(() => resolve({ ...base, USE_EMBEDDED_WEED_MINI: 'false', S3_PUBLIC_ENDPOINT: 'https://reader.example/s3' })).toThrow('path-mounted');
  });

  test('keeps S3_ENDPOINT as an explicit, flagged compatibility alias', () => {
    expect(resolve({
      ...base,
      S3_INTERNAL_ENDPOINT: '',
      S3_ENDPOINT: 'https://s3.reader.example',
      S3_BROWSER_TRANSPORT: 'presigned',
    })).toMatchObject({
      mode: 'presigned',
      internalEndpoint: 'https://s3.reader.example',
      publicEndpoint: 'https://s3.reader.example',
      usesDeprecatedEndpoint: true,
    });
  });
});
