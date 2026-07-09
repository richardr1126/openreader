export const ACCOUNT_EXPORT_SCHEMA_VERSION = 4;

type ExportDocument = {
  id: string;
  name: string;
  [key: string]: unknown;
};

export type UserExportManifestDocumentFile = {
  documentId: string;
  objectKey: string;
  entryName: string;
};

export type UserExportManifest = {
  schemaVersion: typeof ACCOUNT_EXPORT_SCHEMA_VERSION;
  exportedAtMs: number;
  userId: string;
  storageUserId: string;
  namespace: string | null;
  scope: 'owned';
  files: UserExportManifestDocumentFile[];
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
    documents: ExportDocument[];
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

export type BuildUserExportManifestInput = {
  userId: string;
  storageUserId: string;
  namespace: string | null;
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
  getDocumentObjectKey: (documentId: string) => string;
};

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

export function buildUserExportManifest(input: BuildUserExportManifestInput): UserExportManifest {
  const {
    userId,
    storageUserId,
    namespace,
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
    getDocumentObjectKey,
  } = input;

  const files: UserExportManifestDocumentFile[] = documents.map((doc) => {
    const documentId = toSafePathSegment(doc.id, 'document');
    const fileName = toSafePathSegment(doc.name || `${doc.id}.bin`, `${documentId}.bin`);
    return {
      documentId: doc.id,
      objectKey: getDocumentObjectKey(doc.id),
      entryName: `files/documents/${documentId}/${fileName}`,
    };
  });

  return {
    schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
    exportedAtMs,
    userId,
    storageUserId,
    namespace,
    scope: 'owned',
    files,
    entries: {
      profile: profileData,
      preferences,
      folders,
      onboarding,
      readingHistory,
      ttsUsage,
      jobEvents,
      documentSettings,
      authSessions,
      linkedAccounts,
      documents,
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
