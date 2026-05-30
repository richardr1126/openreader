import { describe, expect, test } from 'vitest';
import { getOpenReaderTestNamespace } from '../../src/lib/server/testing/test-namespace';
import { withEnv } from './support/env';

function headers(value: string): Headers {
  return new Headers({ 'x-openreader-test-namespace': value });
}

describe('getOpenReaderTestNamespace gate', () => {
  test('honored in non-production builds', async () => {
    await withEnv({ NODE_ENV: 'development', ENABLE_TEST_NAMESPACE: undefined }, () => {
      expect(getOpenReaderTestNamespace(headers('chromium'))).toBe('chromium');
    });
  });

  test('ignored on production builds without the explicit flag', async () => {
    await withEnv({ NODE_ENV: 'production', ENABLE_TEST_NAMESPACE: undefined }, () => {
      expect(getOpenReaderTestNamespace(headers('attacker'))).toBeNull();
    });
  });

  test('honored on production builds when ENABLE_TEST_NAMESPACE=true (CI parity)', async () => {
    await withEnv({ NODE_ENV: 'production', ENABLE_TEST_NAMESPACE: 'true' }, () => {
      expect(getOpenReaderTestNamespace(headers('webkit'))).toBe('webkit');
    });
  });
});
