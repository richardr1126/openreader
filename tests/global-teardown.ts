import { and, eq, inArray, like, ne } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documentPreviews, documents } from '@openreader/database/schema';
import { deleteDocumentPrefix } from '../src/lib/server/documents/blobstore';
import { deleteTtsSegmentPrefix } from '../src/lib/server/tts/segments-blobstore';
import { getS3Config, isS3Configured } from '../src/lib/server/storage/s3';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

export default async function globalTeardown(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authSchema: any = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
  const testSessions = await db
    .select({ userId: authSchema.session.userId })
    .from(authSchema.session)
    .where(like(authSchema.session.userAgent, '%OpenReader-Playwright/%')) as Array<{ userId: string }>;
  const testUserIds = Array.from(new Set(testSessions.map((row) => row.userId)));

  // Always clear namespaced unclaimed SQL rows from prior runs.
  await db.delete(documents).where(like(documents.userId, 'unclaimed::%'));
  await db.delete(documentPreviews).where(ne(documentPreviews.namespace, ''));

  if (isS3Configured()) {
    const config = getS3Config();
    const docsNsRootPrefix = `${config.prefix}/documents_v1/ns/`;
    const documentPreviewsNsRootPrefix = `${config.prefix}/document_previews_v1/ns/`;
    const tempUploadsNsRootPrefix = `${config.prefix}/document_uploads_temp_v1/ns/`;
    const playbackAudioNsRootPrefix = `${config.prefix}/tts_playback_segments_audio_v1/ns/`;
    const accountExportsNsRootPrefix = `${config.prefix}/account_exports_v1/ns/`;

    await deleteDocumentPrefix(docsNsRootPrefix);
    await deleteDocumentPrefix(documentPreviewsNsRootPrefix);
    await deleteDocumentPrefix(tempUploadsNsRootPrefix);
    await deleteDocumentPrefix(accountExportsNsRootPrefix);
    await deleteTtsSegmentPrefix(playbackAudioNsRootPrefix);
  }

  for (const ids of chunk(testUserIds, 200)) {
    await db
      .delete(authSchema.user)
      .where(and(inArray(authSchema.user.id, ids), eq(authSchema.user.isAnonymous, true)));
  }
}
