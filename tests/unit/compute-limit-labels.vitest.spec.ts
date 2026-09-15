import { describe, expect, test } from 'vitest';
import { usageLabel } from '../../src/components/admin/compute-limit-labels';

describe('compute limit labels', () => {
  test('does not repeat the anonymous audience for the anonymous-device scope', () => {
    expect(usageLabel('anonymous_device', 'anonymous')).toBe('anonymous device');
    expect(usageLabel('user', 'anonymous')).toBe('anonymous user');
  });
});
