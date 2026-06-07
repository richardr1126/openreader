import { sql } from 'drizzle-orm';
import { runInDbTransaction } from '@/db/run-in-transaction';

// In-process serialization for the single-writer SQLite deployment. SQLite runs
// in one process, so an in-memory promise chain per document is sufficient (and
// is the only lock available — there is no advisory lock). On Postgres this is
// unused: the transaction-scoped advisory lock below provides exclusion that
// works across a stateless/serverless fleet.
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

/**
 * Serialize all mutations to a single document and run `fn` with exclusive
 * access, passing it the connection to do its work on.
 *
 * The SQLite/Postgres transaction bridge is delegated to `runInDbTransaction`;
 * this helper only adds the exclusion on top:
 *   - Postgres: a transaction-scoped advisory lock keyed on the document id,
 *     acquired as the first statement of the shared transaction so it covers
 *     the whole read-modify-write. It releases on commit, so it is safe under
 *     transaction-mode poolers and gives fleet-wide exclusion in a stateless
 *     deployment.
 *   - SQLite: an in-process lock; the single WAL writer needs nothing more.
 *
 * Because this guarantees exclusivity for the document, `fn` does not need its
 * own transaction or `SELECT ... FOR UPDATE` to read-modify-write safely.
 */
export async function withDocumentLock<T>(
  documentId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (conn: any) => Promise<T>,
): Promise<T> {
  if (process.env.POSTGRES_URL) {
    return runInDbTransaction(async (conn) => {
      await conn.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${documentId}, 0))`);
      return fn(conn);
    });
  }

  return withLocalDocumentLock(documentId, () => runInDbTransaction(fn));
}
