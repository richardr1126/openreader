import { describe, expect, test } from 'vitest';

import { resolveWeedMiniAdvertiseHost } from '../../packages/bootstrap/src/embedded-seaweedfs.mjs';

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
});
