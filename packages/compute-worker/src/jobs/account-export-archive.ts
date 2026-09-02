import archiver from 'archiver';
import { PassThrough } from 'node:stream';

export const ACCOUNT_EXPORT_SCHEMA_VERSION = 4;

export type AccountExportManifestDocumentFile = {
  documentId: string;
  objectKey: string;
  entryName: string;
};

export type AccountExportManifest = {
  schemaVersion: typeof ACCOUNT_EXPORT_SCHEMA_VERSION;
  exportedAtMs: number;
  userId: string;
  storageUserId: string;
  namespace: string | null;
  scope: 'owned';
  files: AccountExportManifestDocumentFile[];
  entries: {
    profile: unknown;
    preferences: unknown | null;
    folders: unknown[];
    onboarding: unknown | null;
    readingHistory: unknown[];
    ttsUsage: unknown[];
    jobEvents: unknown[];
    documentSettings: unknown[];
    authSessions: unknown[];
    linkedAccounts: unknown[];
    documents: unknown[];
  };
  includes: {
    metadata: true;
    documentFiles: boolean;
    credentialSecrets: false;
    temporaryUploads: false;
    derivedDocumentPreviews: false;
    derivedParsedDocuments: false;
    filesystemSources: false;
  };
};

type AccountExportIssue = {
  scope: 'document';
  id: string;
  objectKey: string;
  message: string;
};

export type BuildAccountExportArchiveInput = {
  manifest: AccountExportManifest;
  readObject: (key: string) => Promise<ArrayBuffer>;
  onProgress?: (progress: {
    phase: 'assembling' | 'uploading';
    completedFiles: number;
    plannedFiles: number;
  }) => Promise<void>;
};

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Unknown error';
}

function appendJson(archive: archiver.Archiver, name: string, data: unknown): void {
  archive.append(JSON.stringify(data, null, 2), { name });
}

function validateManifest(manifest: AccountExportManifest): void {
  if (manifest.schemaVersion !== ACCOUNT_EXPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported account export manifest version: ${String(manifest.schemaVersion)}`);
  }
  if (manifest.scope !== 'owned') {
    throw new Error('Unsupported account export scope');
  }
}

export async function buildAccountExportArchive(input: BuildAccountExportArchiveInput): Promise<Buffer> {
  const { manifest, readObject, onProgress } = input;
  validateManifest(manifest);

  const archive = archiver('zip', {
    zlib: { level: 0 },
    forceZip64: true,
  });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (warning) => {
      if ((warning as NodeJS.ErrnoException).code !== 'ENOENT') reject(warning);
    });
  });
  archive.pipe(output);

  appendJson(archive, 'profile.json', manifest.entries.profile);
  if (manifest.entries.preferences) {
    appendJson(archive, 'preferences.json', manifest.entries.preferences);
  }
  appendJson(archive, 'folders.json', manifest.entries.folders);
  if (manifest.entries.onboarding) appendJson(archive, 'onboarding.json', manifest.entries.onboarding);
  appendJson(archive, 'reading_history.json', manifest.entries.readingHistory);
  appendJson(archive, 'tts_usage.json', manifest.entries.ttsUsage);
  appendJson(archive, 'job_events.json', manifest.entries.jobEvents);
  appendJson(archive, 'document_settings.json', manifest.entries.documentSettings);
  appendJson(archive, 'auth_sessions.json', manifest.entries.authSessions);
  appendJson(archive, 'linked_accounts.json', manifest.entries.linkedAccounts);
  appendJson(archive, 'library_documents.json', manifest.entries.documents);

  const issues: AccountExportIssue[] = [];
  let completedFiles = 0;
  for (const file of manifest.includes.documentFiles ? manifest.files : []) {
    try {
      const bytes = Buffer.from(await readObject(file.objectKey));
      archive.append(bytes, { name: file.entryName });
      completedFiles += 1;
    } catch (error) {
      issues.push({
        scope: 'document',
        id: file.documentId,
        objectKey: file.objectKey,
        message: normalizeErrorMessage(error),
      });
    }
    await onProgress?.({
      phase: 'assembling',
      completedFiles,
      plannedFiles: manifest.files.length,
    });
  }

  appendJson(archive, 'export_manifest.json', {
    formatVersion: manifest.schemaVersion,
    exportedAtMs: manifest.exportedAtMs,
    userId: manifest.userId,
    scope: manifest.scope,
    counts: {
      documentsMetadata: manifest.entries.documents.length,
      documentSettingsMetadata: manifest.entries.documentSettings.length,
      authSessionsMetadata: manifest.entries.authSessions.length,
      linkedAccountsMetadata: manifest.entries.linkedAccounts.length,
      jobEventsMetadata: manifest.entries.jobEvents.length,
      documentFiles: completedFiles,
      issues: issues.length,
    },
    includes: manifest.includes,
  });
  if (issues.length > 0) {
    appendJson(archive, 'export_issues.json', issues);
  }

  await onProgress?.({
    phase: 'uploading',
    completedFiles,
    plannedFiles: manifest.files.length,
  });
  await archive.finalize();
  return done;
}
