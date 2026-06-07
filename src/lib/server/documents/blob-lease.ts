import { randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '@/db';
import { documentBlobLeases } from '@/db/schema';
import { errorToLog, serverLogger } from '@/lib/server/logger';

const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const RETRY_DELAY_MS = 100;

export type DocumentBlobLease = {
  owner: string;
  release: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function tryAcquireDocumentBlobLease(
  documentId: string,
  options?: { leaseMs?: number },
): Promise<DocumentBlobLease | null> {
  const owner = randomUUID();
  const now = Date.now();
  const leaseUntilMs = now + (options?.leaseMs ?? DEFAULT_LEASE_MS);

  const claimed = await db
    .insert(documentBlobLeases)
    .values({ documentId, leaseOwner: owner, leaseUntilMs })
    .onConflictDoUpdate({
      target: documentBlobLeases.documentId,
      set: { leaseOwner: owner, leaseUntilMs },
      where: lt(documentBlobLeases.leaseUntilMs, now),
    })
    .returning({ owner: documentBlobLeases.leaseOwner });

  if (claimed[0]?.owner !== owner) return null;

  return {
    owner,
    release: async () => {
      await db
        .delete(documentBlobLeases)
        .where(and(
          eq(documentBlobLeases.documentId, documentId),
          eq(documentBlobLeases.leaseOwner, owner),
        ));
    },
  };
}

export async function withDocumentBlobLease<T>(
  documentId: string,
  fn: () => Promise<T>,
  options?: { waitMs?: number; leaseMs?: number },
): Promise<T> {
  const deadline = Date.now() + (options?.waitMs ?? 30_000);
  let lease: DocumentBlobLease | null = null;

  while (!lease && Date.now() <= deadline) {
    lease = await tryAcquireDocumentBlobLease(documentId, options);
    if (!lease) await sleep(RETRY_DELAY_MS);
  }
  if (!lease) {
    throw new Error(`Timed out waiting for document blob lease: ${documentId}`);
  }

  try {
    return await fn();
  } finally {
    // Release in its own try/catch so a failing release never masks the
    // original error (or result) produced by fn().
    try {
      await lease.release();
    } catch (releaseError) {
      serverLogger.warn({
        event: 'documents.blobLease.release.failed',
        degraded: true,
        documentId,
        error: errorToLog(releaseError),
      }, 'Failed to release document blob lease');
    }
  }
}
