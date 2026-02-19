import { NextRequest, NextResponse } from 'next/server';
import { claimAnonymousData } from '@/lib/server/user/claim-data';
import { auth } from '@/lib/server/auth/auth';
import { db } from '@/db';
import { audiobooks, documents, userDocumentProgress, userPreferences } from '@/db/schema';
import { count, eq, ne } from 'drizzle-orm';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';

async function checkClaimMigrationReadiness(): Promise<NextResponse | null> {
  const [legacyRows] = await db
    .select({ count: count() })
    .from(documents)
    .where(ne(documents.filePath, documents.id));

  if (Number(legacyRows?.count ?? 0) > 0) {
    return NextResponse.json(
      { error: 'Document metadata migration is still pending. Wait for startup migrations to complete.' },
      { status: 409 },
    );
  }

  return null;
}

async function getClaimableCounts(
  unclaimedUserId: string,
): Promise<{ documents: number; audiobooks: number; preferences: number; progress: number }> {
  const [[docCount], [bookCount], [preferencesCount], [progressCount]] =
    await Promise.all([
      db.select({ count: count() }).from(documents).where(eq(documents.userId, unclaimedUserId)),
      db.select({ count: count() }).from(audiobooks).where(eq(audiobooks.userId, unclaimedUserId)),
      db.select({ count: count() }).from(userPreferences).where(eq(userPreferences.userId, unclaimedUserId)),
      db.select({ count: count() }).from(userDocumentProgress).where(eq(userDocumentProgress.userId, unclaimedUserId)),
    ]);

  return {
    documents: Number(docCount?.count ?? 0),
    audiobooks: Number(bookCount?.count ?? 0),
    preferences: Number(preferencesCount?.count ?? 0),
    progress: Number(progressCount?.count ?? 0),
  };
}

export async function GET(req: NextRequest) {
  try {
    const session = await auth?.api.getSession({ headers: req.headers });
    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const readiness = await checkClaimMigrationReadiness();
    if (readiness) return readiness;

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const counts = await getClaimableCounts(unclaimedUserId);
    return NextResponse.json({ success: true, ...counts });
  } catch (error) {
    console.error('Error checking claimable data:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth?.api.getSession({ headers: req.headers });
    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const readiness = await checkClaimMigrationReadiness();
    if (readiness) return readiness;

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const userId = session.user.id;

    const result = await claimAnonymousData(userId, unclaimedUserId, testNamespace);

    return NextResponse.json({
      success: true,
      claimed: result
    });

  } catch (error) {
    console.error('Error claiming data:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
