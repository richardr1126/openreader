import { describe, expect, test } from 'vitest';
import { usageLabel } from '../../src/components/admin/compute-limit-labels';

describe('compute limit labels', () => {
  test('labels the user audience', () => {
    expect(usageLabel('user', 'anonymous')).toBe('Guest');
    expect(usageLabel('user', 'authenticated')).toBe('Account');
  });
});
