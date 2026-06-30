import type { Archiver } from 'archiver';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';

export type ExportBlobBody =
  | NodeJS.ReadableStream
  | ReadableStream<Uint8Array>
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | { transformToByteArray: () => Promise<Uint8Array> };

type ExportIssueScope = 'document';

type ExportIssue = {
  scope: ExportIssueScope;
  id: string;
  fileName?: string;
  message: string;
};

type ExportDocument = {
  id: string;
  name: string;
  [key: string]: unknown;
};

export type AppendUserExportArchiveInput = {
  archive: Archiver;
  userId: string;
  exportedAtMs: number;
  profileData: unknown;
  preferences: unknown | null;
  folders?: unknown[];
  onboarding?: unknown | null;
  readingHistory: unknown[];
  ttsUsage: unknown[];
  jobEvents: unknown[];
  documentSettings: unknown[];
  authSessions: unknown[];
  linkedAccounts: unknown[];
  documents: ExportDocument[];
  storageEnabled: boolean;
  getDocumentBlobStream: (documentId: string) => Promise<ExportBlobBody>;
};

function isNodeReadableStream(value: unknown): value is Readable {
  return value instanceof Readable;
}

function isWebReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof value === 'object' && 'getReader' in value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
}

function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, '');
}

function toSafePathSegment(value: string, fallback: string): string {
  const stripped = stripControlChars(String(value ?? ''));
  const withoutSlashes = stripped.replace(/[\/\\]/g, '_').trim();
  const withoutTraversal = withoutSlashes.replace(/\.\.+/g, '_');
  const collapsed = withoutTraversal.replace(/\s+/g, ' ').replace(/\.+$/, '').slice(0, 240);
  return collapsed.length > 0 ? collapsed : fallback;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Unknown error';
}

function appendJson(archive: Archiver, name: string, data: unknown): void {
  archive.append(JSON.stringify(data, null, 2), { name });
}

async function bodyToNodeReadable(body: ExportBlobBody): Promise<Readable> {
  if (isNodeReadableStream(body)) return body;
  if (isWebReadableStream(body)) {
    return Readable.fromWeb(body as unknown as NodeReadableStream);
  }
  if (body instanceof Uint8Array) {
    return Readable.from([body]);
  }
  if (ArrayBuffer.isView(body)) {
    return Readable.from([new Uint8Array(body.buffer, body.byteOffset, body.byteLength)]);
  }
  if (body instanceof ArrayBuffer) {
    return Readable.from([new Uint8Array(body)]);
  }
  if (typeof body === 'object' && body !== null && 'transformToByteArray' in body) {
    const bytes = await body.transformToByteArray();
    return Readable.from([bytes]);
  }
  throw new Error('Unsupported blob body type');
}

export async function appendUserExportArchive(input: AppendUserExportArchiveInput): Promise<void> {
  const {
    archive,
    userId,
    exportedAtMs,
    profileData,
    preferences,
    folders = [],
    onboarding = null,
    readingHistory,
    ttsUsage,
    jobEvents,
    documentSettings,
    authSessions,
    linkedAccounts,
    documents,
    storageEnabled,
    getDocumentBlobStream,
  } = input;

  const issues: ExportIssue[] = [];
  let documentFilesExported = 0;

  appendJson(archive, 'profile.json', profileData);
  if (preferences) {
    appendJson(archive, 'preferences.json', preferences);
  }
  appendJson(archive, 'folders.json', folders);
  if (onboarding) appendJson(archive, 'onboarding.json', onboarding);
  appendJson(archive, 'reading_history.json', readingHistory);
  appendJson(archive, 'tts_usage.json', ttsUsage);
  appendJson(archive, 'job_events.json', jobEvents);
  appendJson(archive, 'document_settings.json', documentSettings);
  appendJson(archive, 'auth_sessions.json', authSessions);
  appendJson(archive, 'linked_accounts.json', linkedAccounts);
  appendJson(archive, 'library_documents.json', documents);

  for (const doc of storageEnabled ? documents : []) {
    const documentId = toSafePathSegment(doc.id, 'document');
    const fileName = toSafePathSegment(doc.name || `${doc.id}.bin`, `${documentId}.bin`);
    const entryName = `files/documents/${documentId}/${fileName}`;

    try {
      const body = await getDocumentBlobStream(doc.id);
      const stream = await bodyToNodeReadable(body);
      archive.append(stream, { name: entryName });
      documentFilesExported += 1;
    } catch (error) {
      issues.push({
        scope: 'document',
        id: doc.id,
        fileName,
        message: normalizeErrorMessage(error),
      });
    }
  }

  const manifest = {
    formatVersion: 3,
    exportedAtMs,
    userId,
    scope: 'owned',
    counts: {
      documentsMetadata: documents.length,
      documentSettingsMetadata: documentSettings.length,
      authSessionsMetadata: authSessions.length,
      linkedAccountsMetadata: linkedAccounts.length,
      jobEventsMetadata: jobEvents.length,
      documentFiles: documentFilesExported,
      issues: issues.length,
    },
    includes: {
      metadata: true,
      documentFiles: storageEnabled,
      credentialSecrets: false,
      temporaryUploads: false,
      derivedDocumentPreviews: false,
      derivedParsedDocuments: false,
      filesystemSources: false,
    },
  };

  appendJson(archive, 'export_manifest.json', manifest);

  if (issues.length > 0) {
    appendJson(archive, 'export_issues.json', issues);
  }
}
