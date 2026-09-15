import { describe, expect, test, vi } from 'vitest';

import { resolveAccountExportReference } from '../../src/lib/server/user/account-export-resolution';

const reference = {
  artifactId: 'abcdef1234567890',
  storageUserId: 'user-1',
  namespace: null,
  manifestHash: 'a'.repeat(64),
};

describe('account export reference resolution', () => {
  test('falls back to a queued legacy version 4 operation', async () => {
    const resolveAccountExport = vi.fn(async ({ schemaVersion }: { schemaVersion: number }) => ({
      artifact: null,
      operation: schemaVersion === 4
        ? { opId: 'legacy-op', status: 'running' }
        : null,
    }));

    const result = await resolveAccountExportReference({
      client: { resolveAccountExport } as never,
      reference,
    });

    expect(resolveAccountExport.mock.calls.map(([input]) => input.schemaVersion)).toEqual([5, 4]);
    expect(result.schemaVersion).toBe(4);
    expect(result.resolution.operation).toMatchObject({ opId: 'legacy-op' });
  });

  test('preserves the recorded version when resolving a legacy artifact', async () => {
    const resolveAccountExport = vi.fn(async ({ schemaVersion }: { schemaVersion: number }) => ({
      artifact: schemaVersion === 4
        ? { exportSchemaVersion: 4, artifactId: reference.artifactId }
        : null,
      operation: null,
    }));

    const result = await resolveAccountExportReference({
      client: { resolveAccountExport } as never,
      reference,
    });

    expect(result.schemaVersion).toBe(4);
    expect(result.resolution.artifact).toMatchObject({ exportSchemaVersion: 4 });
  });
});
