import { NextRequest, NextResponse } from 'next/server';
import { PassThrough, Readable } from 'stream';
import { auth } from '@/lib/server/auth/auth';
import { db } from '@/db';
import {
  documents,
  audiobooks,
  audiobookChapters,
  documentSettings,
  ttsSegmentEntries,
  ttsSegmentVariants,
  userDocumentProgress,
  userJobEvents,
  userPreferences,
  userTtsChars,
} from '@/db/schema';
import * as authSchemaSqlite from '@/db/schema_auth_sqlite';
import * as authSchemaPostgres from '@/db/schema_auth_postgres';
import { and, desc, eq, inArray } from 'drizzle-orm';
import archiver from 'archiver';
import { appendUserExportArchive } from '@/lib/server/user/data-export';
import { getDocumentBlobStream } from '@/lib/server/documents/blobstore';
import { getAudiobookObjectStream, listAudiobookObjects } from '@/lib/server/audiobooks/blobstore';
import { getTtsSegmentAudioObjectStream } from '@/lib/server/tts/segments-blobstore';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!auth) {
    return errorResponse(new Error('Auth not initialized'), {
      apiErrorMessage: 'Auth not initialized',
      normalize: { code: 'USER_EXPORT_AUTH_NOT_INITIALIZED', errorClass: 'auth', httpStatus: 500 },
    });
  }

  const session = await auth.api.getSession({
    headers: req.headers,
  });

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const testNamespace = getOpenReaderTestNamespace(req.headers);
  const storageEnabled = isS3Configured();
  const requireStorage = () => {
    if (!storageEnabled) {
      throw new Error('Storage is not configured; file content could not be exported');
    }
  };

  const [
    prefs,
    progress,
    ttsUsage,
    jobEvents,
    perDocumentSettings,
    segmentEntries,
    segmentVariants,
    userDocs,
    userAudiobooks,
  ] = await Promise.all([
    db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1),
    db
      .select()
      .from(userDocumentProgress)
      .where(eq(userDocumentProgress.userId, userId))
      .orderBy(desc(userDocumentProgress.updatedAt)),
    db
      .select()
      .from(userTtsChars)
      .where(eq(userTtsChars.userId, userId))
      .orderBy(desc(userTtsChars.date)),
    db
      .select()
      .from(userJobEvents)
      .where(eq(userJobEvents.userId, userId))
      .orderBy(desc(userJobEvents.createdAt)),
    db
      .select()
      .from(documentSettings)
      .where(eq(documentSettings.userId, userId))
      .orderBy(desc(documentSettings.updatedAt)),
    db
      .select()
      .from(ttsSegmentEntries)
      .where(eq(ttsSegmentEntries.userId, userId))
      .orderBy(desc(ttsSegmentEntries.updatedAt)),
    db
      .select()
      .from(ttsSegmentVariants)
      .where(eq(ttsSegmentVariants.userId, userId))
      .orderBy(desc(ttsSegmentVariants.updatedAt)),
    db
      .select()
      .from(documents)
      .where(eq(documents.userId, userId))
      .orderBy(desc(documents.lastModified)),
    db
      .select()
      .from(audiobooks)
      .where(eq(audiobooks.userId, userId))
      .orderBy(desc(audiobooks.createdAt)),
  ]);

  const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
  // Auth exports intentionally select metadata only. Credential and session
  // secrets must never be written into the archive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const database = db as any;
  const [authSessions, linkedAccounts] = await Promise.all([
    database
      .select({
        id: authSchema.session.id,
        expiresAt: authSchema.session.expiresAt,
        createdAt: authSchema.session.createdAt,
        updatedAt: authSchema.session.updatedAt,
        ipAddress: authSchema.session.ipAddress,
        userAgent: authSchema.session.userAgent,
      })
      .from(authSchema.session)
      .where(eq(authSchema.session.userId, userId)),
    database
      .select({
        id: authSchema.account.id,
        accountId: authSchema.account.accountId,
        providerId: authSchema.account.providerId,
        scope: authSchema.account.scope,
        createdAt: authSchema.account.createdAt,
        updatedAt: authSchema.account.updatedAt,
      })
      .from(authSchema.account)
      .where(eq(authSchema.account.userId, userId)),
  ]);

  const archive = archiver('zip', {
    zlib: { level: 0 },
    forceZip64: true,
  });

  const output = new PassThrough();
  archive.pipe(output);

  archive.on('warning', (warning) => {
    if ((warning as NodeJS.ErrnoException).code !== 'ENOENT') {
      serverLogger.warn({
        event: 'user.export.archive.warning',
        degraded: true,
        step: 'archive_warning',
        error: errorToLog(warning),
      }, 'User export warning');
    }
  });

  archive.on('error', (error) => {
    output.destroy(error);
  });

  const bookIds = userAudiobooks.map((book: typeof audiobooks.$inferSelect) => book.id);
  const allChapters = bookIds.length > 0
    ? await db
      .select()
      .from(audiobookChapters)
      .where(and(eq(audiobookChapters.userId, userId), inArray(audiobookChapters.bookId, bookIds)))
    : [];

  const onAbort = () => {
    archive.abort();
    output.destroy(new Error('Export request aborted'));
  };
  req.signal.addEventListener('abort', onAbort, { once: true });

  (async () => {
    try {
      const exportedAtMs = nowTimestampMs();
      const profileData = {
        user: session.user,
        exportedAtMs,
      };

      await appendUserExportArchive({
        archive,
        userId,
        exportedAtMs,
        profileData,
        preferences: prefs[0] ?? null,
        readingHistory: progress,
        ttsUsage,
        jobEvents,
        documentSettings: perDocumentSettings,
        authSessions,
        linkedAccounts,
        documents: userDocs,
        audiobooks: userAudiobooks,
        audiobookChapters: allChapters,
        ttsSegmentEntries: segmentEntries,
        ttsSegmentVariants: segmentVariants,
        storageEnabled,
        getDocumentBlobStream: async (documentId: string) => {
          requireStorage();
          return getDocumentBlobStream(documentId, testNamespace);
        },
        listAudiobookObjects: async (bookId: string, ownerId: string) => {
          requireStorage();
          return listAudiobookObjects(bookId, ownerId, testNamespace);
        },
        getAudiobookObjectStream: async (bookId: string, ownerId: string, fileName: string) => {
          requireStorage();
          return getAudiobookObjectStream(bookId, ownerId, fileName, testNamespace);
        },
        getTtsSegmentAudioStream: async (audioKey: string) => {
          requireStorage();
          return (await getTtsSegmentAudioObjectStream(audioKey)).stream;
        },
      });

      if (!req.signal.aborted) {
        await archive.finalize();
      }
    } catch (error) {
      serverLogger.error({
        event: 'user.export.generate.failed',
        error: errorToLog(error),
      }, 'Export generation failed');
      archive.abort();
      output.destroy(error instanceof Error ? error : new Error('Failed to generate export archive'));
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      if (req.signal.aborted) {
        output.destroy(new Error('Export request aborted'));
      }
    }
  })();

  return new NextResponse(Readable.toWeb(output) as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="openreader-data-${userId.slice(0, 8)}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}
