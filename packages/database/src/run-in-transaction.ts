import { db } from './index';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema';
import { resolveSqliteDatabasePath } from './sqlite-path.js';

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteTransactionDb: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteTransactionRaw: any = null;
let sqliteTransactionTail: Promise<void> = Promise.resolve();

function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

function getSqliteTransactionConnection() {
  if (sqliteTransactionDb) return { db: sqliteTransactionDb, raw: sqliteTransactionRaw };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const databasePath = resolveSqliteDatabasePath(findWorkspaceRoot(process.cwd()));
  sqliteTransactionRaw = new Database(databasePath);
  sqliteTransactionRaw.pragma('journal_mode = WAL');
  sqliteTransactionRaw.pragma('busy_timeout = 5000');
  sqliteTransactionDb = drizzle(sqliteTransactionRaw, { schema });
  return { db: sqliteTransactionDb, raw: sqliteTransactionRaw };
}

/** Close the dedicated SQLite transaction connection if it was opened. */
export async function closeTransactionConnection(): Promise<void> {
  await sqliteTransactionTail;
  sqliteTransactionRaw?.close();
  sqliteTransactionRaw = null;
  sqliteTransactionDb = null;
}

/**
 * Run `fn` with a database connection, wrapped in a transaction on Postgres.
 *
 * This is the single definition of the SQLite/Postgres bridge, so callers never
 * branch on `process.env.POSTGRES_URL` themselves:
 *   - Postgres: opens a real transaction so a multi-statement read-modify-write
 *     is atomic, and passes the transaction handle as `conn`.
 *   - SQLite: a dedicated serialized connection holds BEGIN IMMEDIATE across
 *     the async callback. This avoids committing between awaited statements
 *     and prevents unrelated requests on the shared connection from becoming
 *     part of the transaction.
 */
export async function runInDbTransaction<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (conn: any) => Promise<T>,
): Promise<T> {
  if (process.env.POSTGRES_URL) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (db as any).transaction(async (tx: any) => fn(tx));
  }
  const previous = sqliteTransactionTail;
  let release: () => void = () => undefined;
  sqliteTransactionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  let connection: ReturnType<typeof getSqliteTransactionConnection> | null = null;
  try {
    connection = getSqliteTransactionConnection();
    connection.raw.exec('BEGIN IMMEDIATE');
    const result = await fn(connection.db);
    connection.raw.exec('COMMIT');
    return result;
  } catch (error) {
    if (connection?.raw.inTransaction) connection.raw.exec('ROLLBACK');
    throw error;
  } finally {
    release();
  }
}
