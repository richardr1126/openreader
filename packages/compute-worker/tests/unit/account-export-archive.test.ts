import { describe, expect, test } from 'vitest';

import {
  ACCOUNT_EXPORT_SCHEMA_VERSION,
  buildAccountExportArchive,
  type AccountExportManifest,
  type SupportedAccountExportManifest,
} from '../../src/jobs/account-export-archive';

function manifest(): AccountExportManifest {
  return {
    schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
    exportedAtMs: 123,
    userId: 'user-1',
    storageUserId: 'user-1',
    namespace: null,
    scope: 'owned',
    files: [],
    entries: {
      profile: { id: 'user-1' },
      preferences: null,
      folders: [],
      onboarding: null,
      readingHistory: [],
      computeLimitAdmissions: [{ action: 'account_export' }],
      computeLimitEvents: [{ metric: 'characters', units: 10 }],
      documentSettings: [],
      authSessions: [],
      linkedAccounts: [],
      documents: [],
    },
    includes: {
      metadata: true,
      documentFiles: true,
      credentialSecrets: false,
      temporaryUploads: false,
      derivedDocumentPreviews: false,
      derivedParsedDocuments: false,
      filesystemSources: false,
    },
  };
}

describe('account export archive', () => {
  test('accepts the current app manifest and writes unified compute-limit metadata', async () => {
    const archive = await buildAccountExportArchive({
      manifest: manifest(),
      readObject: async () => new ArrayBuffer(0),
    });
    const bytes = archive.toString('latin1');

    expect(ACCOUNT_EXPORT_SCHEMA_VERSION).toBe(5);
    expect(bytes).toContain('compute_limit_admissions.json');
    expect(bytes).toContain('compute_limit_events.json');
    expect(bytes).not.toContain('tts_usage.json');
    expect(bytes).not.toContain('job_events.json');
  });

  test('finishes a queued schema-version-4 export with its original archive layout', async () => {
    const current = manifest();
    const legacyManifest = {
      ...current,
      schemaVersion: 4,
      entries: {
        ...current.entries,
        ttsUsage: [{ characters: 10 }],
        jobEvents: [{ type: 'tts' }],
        computeLimitAdmissions: undefined,
        computeLimitEvents: undefined,
      },
    } as unknown as SupportedAccountExportManifest;
    const archive = await buildAccountExportArchive({
      manifest: legacyManifest,
      readObject: async () => new ArrayBuffer(0),
    });
    const bytes = archive.toString('latin1');

    expect(bytes).toContain('tts_usage.json');
    expect(bytes).toContain('job_events.json');
    expect(bytes).not.toContain('compute_limit_admissions.json');
    expect(bytes).not.toContain('compute_limit_events.json');
  });

  test('rejects unsupported manifest versions', async () => {
    await expect(buildAccountExportArchive({
      manifest: { ...manifest(), schemaVersion: 3 } as unknown as AccountExportManifest,
      readObject: async () => new ArrayBuffer(0),
    })).rejects.toThrow('Unsupported account export manifest version: 3');
  });
});
