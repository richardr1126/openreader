import { sql } from 'drizzle-orm';
import { db } from '@/db';

const localTails = new Map<string, Promise<void>>();

async function withLocalDocumentLock<T>(documentId: string, fn: () => Promise<T>): Promise<T> {
  const previous = localTails.get(documentId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  localTails.set(documentId, current);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (localTails.get(documentId) === current) {
      localTails.delete(documentId);
    }
  }
}

export async function withDocumentMutationLock<T>(
  documentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withLocalDocumentLock(documentId, async () => {
    if (!process.env.POSTGRES_URL) {
      return fn();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (db as any).transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${documentId}, 0))`);
      return fn();
    });
  });
}
