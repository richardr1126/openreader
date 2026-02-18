import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '../src/db';
import { audiobooks, audiobookChapters, documents } from '../src/db/schema';
import { deleteDocumentPrefix } from '../src/lib/server/documents/blobstore';
import { deleteAudiobookPrefix } from '../src/lib/server/audiobooks/blobstore';
import { getS3Client, getS3Config, isS3Configured } from '../src/lib/server/storage/s3';

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

async function listKeysByPrefix(prefix: string): Promise<string[]> {
  const config = getS3Config();
  const client = getS3Client();
  let continuationToken: string | undefined;
  const keys: string[] = [];

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const entry of response.Contents ?? []) {
      if (entry.Key) keys.push(entry.Key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

function parseAudiobookScopeFromKey(
  key: string,
  audiobooksNsRootPrefix: string,
): { userId: string; bookId: string } | null {
  if (!key.startsWith(audiobooksNsRootPrefix)) return null;
  const rel = key.slice(audiobooksNsRootPrefix.length);
  const parts = rel.split('/');
  // ns/<namespace>/users/<userId>/<bookId>-audiobook/<file>
  if (parts.length < 5) return null;
  if (parts[1] !== 'users') return null;
  const encodedUserId = parts[2];
  const dirName = parts[3];
  if (!encodedUserId || !dirName.endsWith('-audiobook')) return null;
  const bookId = dirName.slice(0, -'-audiobook'.length);
  if (!bookId) return null;

  let userId: string;
  try {
    userId = decodeURIComponent(encodedUserId);
  } catch {
    return null;
  }
  return { userId, bookId };
}

export default async function globalTeardown(): Promise<void> {
  // Always clear namespaced no-auth SQL rows from prior runs.
  await db.delete(audiobookChapters).where(like(audiobookChapters.userId, 'unclaimed::%'));
  await db.delete(audiobooks).where(like(audiobooks.userId, 'unclaimed::%'));
  await db.delete(documents).where(like(documents.userId, 'unclaimed::%'));

  if (!isS3Configured()) return;

  const config = getS3Config();
  const docsNsRootPrefix = `${config.prefix}/documents_v1/ns/`;
  const audiobooksNsRootPrefix = `${config.prefix}/audiobooks_v1/ns/`;

  // Remove SQL audiobook rows for namespaced objects (covers auth claim flows too).
  const audiobookKeys = await listKeysByPrefix(audiobooksNsRootPrefix);
  const byUser = new Map<string, Set<string>>();
  for (const key of audiobookKeys) {
    const scope = parseAudiobookScopeFromKey(key, audiobooksNsRootPrefix);
    if (!scope) continue;
    let set = byUser.get(scope.userId);
    if (!set) {
      set = new Set<string>();
      byUser.set(scope.userId, set);
    }
    set.add(scope.bookId);
  }

  for (const [userId, bookIds] of byUser) {
    for (const ids of chunk(Array.from(bookIds), 200)) {
      await db
        .delete(audiobookChapters)
        .where(and(eq(audiobookChapters.userId, userId), inArray(audiobookChapters.bookId, ids)));
      await db
        .delete(audiobooks)
        .where(and(eq(audiobooks.userId, userId), inArray(audiobooks.id, ids)));
    }
  }

  await deleteDocumentPrefix(docsNsRootPrefix);
  await deleteAudiobookPrefix(audiobooksNsRootPrefix);
}
