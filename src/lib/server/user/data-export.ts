import type { Archiver } from 'archiver';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { decodeChapterFileName } from '@/lib/server/audiobooks/chapters';

export type ExportBlobBody =
  | NodeJS.ReadableStream
  | ReadableStream<Uint8Array>
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | { transformToByteArray: () => Promise<Uint8Array> };

type ExportIssueScope = 'document' | 'audiobook' | 'audiobook_list' | 'tts_segment';

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

type ExportAudiobook = {
  id: string;
  [key: string]: unknown;
};

type ExportAudiobookChapter = {
  bookId: string;
  [key: string]: unknown;
};

type ExportAudiobookObject = {
  fileName: string;
  [key: string]: unknown;
};

type ExportTtsSegmentEntry = {
  segmentEntryId: string;
  documentId: string;
  [key: string]: unknown;
};

type ExportTtsSegmentVariant = {
  segmentId: string;
  segmentEntryId: string;
  audioKey?: string | null;
  audioFormat?: string | null;
  [key: string]: unknown;
};

export type AppendUserExportArchiveInput = {
  archive: Archiver;
  userId: string;
  exportedAtMs: number;
  profileData: unknown;
  preferences: unknown | null;
  readingHistory: unknown[];
  ttsUsage: unknown[];
  jobEvents: unknown[];
  documentSettings: unknown[];
  authSessions: unknown[];
  linkedAccounts: unknown[];
  documents: ExportDocument[];
  audiobooks: ExportAudiobook[];
  audiobookChapters: ExportAudiobookChapter[];
  ttsSegmentEntries: ExportTtsSegmentEntry[];
  ttsSegmentVariants: ExportTtsSegmentVariant[];
  storageEnabled: boolean;
  getDocumentBlobStream: (documentId: string) => Promise<ExportBlobBody>;
  listAudiobookObjects: (bookId: string, userId: string) => Promise<ExportAudiobookObject[]>;
  getAudiobookObjectStream: (bookId: string, userId: string, fileName: string) => Promise<ExportBlobBody>;
  getTtsSegmentAudioStream: (audioKey: string) => Promise<ExportBlobBody>;
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

export function isPersistedAudiobookExportFileName(fileName: string): boolean {
  if (fileName === 'audiobook.meta.json') return true;
  if (fileName === 'complete.mp3' || fileName === 'complete.m4b') return true;
  if (/^complete\.(mp3|m4b)\.manifest\.json$/i.test(fileName)) return true;
  return decodeChapterFileName(fileName) !== null;
}

export async function appendUserExportArchive(input: AppendUserExportArchiveInput): Promise<void> {
  const {
    archive,
    userId,
    exportedAtMs,
    profileData,
    preferences,
    readingHistory,
    ttsUsage,
    jobEvents,
    documentSettings,
    authSessions,
    linkedAccounts,
    documents,
    audiobooks,
    audiobookChapters,
    ttsSegmentEntries,
    ttsSegmentVariants,
    storageEnabled,
    getDocumentBlobStream,
    listAudiobookObjects,
    getAudiobookObjectStream,
    getTtsSegmentAudioStream,
  } = input;

  const issues: ExportIssue[] = [];
  let documentFilesExported = 0;
  let audiobookFilesExported = 0;
  let ttsSegmentFilesExported = 0;

  appendJson(archive, 'profile.json', profileData);
  if (preferences) {
    appendJson(archive, 'preferences.json', preferences);
  }
  appendJson(archive, 'reading_history.json', readingHistory);
  appendJson(archive, 'tts_usage.json', ttsUsage);
  appendJson(archive, 'job_events.json', jobEvents);
  appendJson(archive, 'document_settings.json', documentSettings);
  appendJson(archive, 'auth_sessions.json', authSessions);
  appendJson(archive, 'linked_accounts.json', linkedAccounts);
  appendJson(archive, 'library_documents.json', documents);
  appendJson(archive, 'tts_segment_entries.json', ttsSegmentEntries);
  appendJson(archive, 'tts_segment_variants.json', ttsSegmentVariants);

  const chaptersByBookId = new Map<string, ExportAudiobookChapter[]>();
  for (const chapter of audiobookChapters) {
    const existing = chaptersByBookId.get(chapter.bookId) ?? [];
    existing.push(chapter);
    chaptersByBookId.set(chapter.bookId, existing);
  }

  const audiobooksWithChapters = audiobooks.map((book) => ({
    ...book,
    chapters: chaptersByBookId.get(book.id) ?? [],
  }));
  appendJson(archive, 'library_audiobooks.json', audiobooksWithChapters);

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

  for (const book of storageEnabled ? audiobooks : []) {
    let objects: ExportAudiobookObject[] = [];
    try {
      objects = await listAudiobookObjects(book.id, userId);
    } catch (error) {
      issues.push({
        scope: 'audiobook_list',
        id: book.id,
        message: normalizeErrorMessage(error),
      });
      continue;
    }

    const persisted = objects
      .filter((object) => typeof object.fileName === 'string' && isPersistedAudiobookExportFileName(object.fileName))
      .sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));

    for (const object of persisted) {
      const safeBookId = toSafePathSegment(book.id, 'book');
      const safeFileName = toSafePathSegment(object.fileName, 'file.bin');
      const entryName = `files/audiobooks/${safeBookId}/${safeFileName}`;

      try {
        const body = await getAudiobookObjectStream(book.id, userId, object.fileName);
        const stream = await bodyToNodeReadable(body);
        archive.append(stream, { name: entryName });
        audiobookFilesExported += 1;
      } catch (error) {
        issues.push({
          scope: 'audiobook',
          id: book.id,
          fileName: object.fileName,
          message: normalizeErrorMessage(error),
        });
      }
    }
  }

  const documentIdByEntryId = new Map(
    ttsSegmentEntries.map((entry) => [entry.segmentEntryId, entry.documentId]),
  );
  for (const variant of storageEnabled ? ttsSegmentVariants : []) {
    const audioKey = typeof variant.audioKey === 'string' ? variant.audioKey : '';
    if (!audioKey) continue;

    const documentId = toSafePathSegment(
      documentIdByEntryId.get(variant.segmentEntryId) ?? 'unknown-document',
      'unknown-document',
    );
    const segmentId = toSafePathSegment(variant.segmentId, 'segment');
    const format = toSafePathSegment(variant.audioFormat || 'mp3', 'mp3');
    const entryName = `files/tts_segments/${documentId}/${segmentId}.${format}`;

    try {
      const body = await getTtsSegmentAudioStream(audioKey);
      const stream = await bodyToNodeReadable(body);
      archive.append(stream, { name: entryName });
      ttsSegmentFilesExported += 1;
    } catch (error) {
      issues.push({
        scope: 'tts_segment',
        id: variant.segmentId,
        fileName: entryName,
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
      audiobooksMetadata: audiobooks.length,
      audiobookChaptersMetadata: audiobookChapters.length,
      documentSettingsMetadata: documentSettings.length,
      ttsSegmentEntriesMetadata: ttsSegmentEntries.length,
      ttsSegmentVariantsMetadata: ttsSegmentVariants.length,
      authSessionsMetadata: authSessions.length,
      linkedAccountsMetadata: linkedAccounts.length,
      jobEventsMetadata: jobEvents.length,
      documentFiles: documentFilesExported,
      audiobookFiles: audiobookFilesExported,
      ttsSegmentFiles: ttsSegmentFilesExported,
      issues: issues.length,
    },
    includes: {
      metadata: true,
      documentFiles: storageEnabled,
      audiobookFiles: storageEnabled,
      ttsSegmentFiles: storageEnabled,
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
