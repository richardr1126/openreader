import { db } from '@/db';

/**
 * Run `fn` with a database connection, wrapped in a transaction on Postgres.
 *
 * This is the single definition of the SQLite/Postgres bridge, so callers never
 * branch on `process.env.POSTGRES_URL` themselves:
 *   - Postgres: opens a real transaction so a multi-statement read-modify-write
 *     is atomic, and passes the transaction handle as `conn`.
 *   - SQLite: better-sqlite3 transactions require synchronous callbacks (they
 *     cannot be awaited) and the database is a single writer anyway, so `fn`
 *     runs directly on the shared connection.
 */
export async function runInDbTransaction<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (conn: any) => Promise<T>,
): Promise<T> {
  if (process.env.POSTGRES_URL) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (db as any).transaction(async (tx: any) => fn(tx));
  }
  return fn(db);
}
