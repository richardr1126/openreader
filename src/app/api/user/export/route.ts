import { NextRequest, NextResponse } from 'next/server';
import { PassThrough, Readable } from 'stream';
import { auth } from '@/lib/server/auth/auth';
import { db } from '@/db';
import { documents, audiobooks, audiobookChapters, userPreferences, userDocumentProgress, userTtsChars } from '@/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import archiver from 'archiver';
import { appendUserExportArchive } from '@/lib/server/user/data-export';
import { getDocumentBlobStream } from '@/lib/server/documents/blobstore';
import { getAudiobookObjectStream, listAudiobookObjects } from '@/lib/server/audiobooks/blobstore';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { nowTimestampMs } from '@/lib/shared/timestamps';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isS3Configured()) {
    return NextResponse.json(
      { error: 'Export storage is not configured. Set S3_* environment variables.' },
      { status: 503 },
    );
  }

  if (!auth) {
    return NextResponse.json({ error: 'Auth not initialized' }, { status: 500 });
  }

  const session = await auth.api.getSession({
    headers: req.headers,
  });

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const testNamespace = getOpenReaderTestNamespace(req.headers);

  const [
    prefs,
    progress,
    ttsUsage,
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
      .from(documents)
      .where(eq(documents.userId, userId))
      .orderBy(desc(documents.lastModified)),
    db
      .select()
      .from(audiobooks)
      .where(eq(audiobooks.userId, userId))
      .orderBy(desc(audiobooks.createdAt)),
  ]);

  const archive = archiver('zip', {
    zlib: { level: 0 },
    forceZip64: true,
  });

  const output = new PassThrough();
  archive.pipe(output);

  archive.on('warning', (warning) => {
    if ((warning as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('User export warning:', warning);
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
        session: session.session,
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
        documents: userDocs,
        audiobooks: userAudiobooks,
        audiobookChapters: allChapters,
        getDocumentBlobStream: async (documentId: string) => getDocumentBlobStream(documentId, testNamespace),
        listAudiobookObjects: async (bookId: string, ownerId: string) => listAudiobookObjects(bookId, ownerId, testNamespace),
        getAudiobookObjectStream: async (bookId: string, ownerId: string, fileName: string) =>
          getAudiobookObjectStream(bookId, ownerId, fileName, testNamespace),
      });

      if (!req.signal.aborted) {
        await archive.finalize();
      }
    } catch (error) {
      console.error('Export generation failed:', error);
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
