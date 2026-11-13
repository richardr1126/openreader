import { describe, expect, test } from 'vitest';
import { COMPUTE_ACTIONS } from '@openreader/runtime-config/compute-limits';
import { COMPUTE_ACTION_GROUPS } from '../../src/components/admin/ComputeLimitsEditor';

describe('Limits tab action groups', () => {
  test('place every compute action exactly once', () => {
    const grouped = COMPUTE_ACTION_GROUPS.flatMap((group) => [...group.actions]);
    expect([...grouped].sort()).toEqual([...COMPUTE_ACTIONS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});
