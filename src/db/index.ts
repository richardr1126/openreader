import { sql } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import * as schema from './schema';
import * as authSchemaSqlite from './schema_auth_sqlite';
import * as authSchemaPostgres from './schema_auth_postgres';

// Database driver modules are loaded lazily via require() inside getDrizzleDB()
// to avoid loading the unused driver (~15-20 MB each) in every serverless function.
// require() is used instead of dynamic import() because getDrizzleDB() must remain
// synchronous for the SQLite code path.


const UNCLAIMED_USER_ID = 'unclaimed';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbInstance: any = null;
let dbIsPostgres = false;

/** Track which system user IDs we have already ensured exist this process. */
const seededUserIds = new Set<string>();

/**
 * Ensure a system/placeholder user row exists in the user table for `userId`.
 * All user-facing tables now have userId foreign keys with ON DELETE CASCADE
 * referencing the user table. When auth is disabled the app stores data under
 * the 'unclaimed' userId (and namespace variants like 'unclaimed::ns'), so
 * those rows must exist before any data can be inserted.
 *
 * This is safe to call repeatedly — it short-circuits via an in-memory Set
 * and uses INSERT … ON CONFLICT/OR IGNORE at the SQL level.
 */
export function ensureSystemUserExists(userId: string) {
  if (seededUserIds.has(userId)) return;
  const drizzleDb = getDrizzleDB();
  try {
    if (dbIsPostgres) {
      // Fire-and-forget: Postgres drizzle returns a Promise. We intentionally
      // don't await (to keep this helper synchronous for SQLite compat), but we
      // only mark the user as seeded once the insert actually resolves.
      drizzleDb.execute(sql`
        INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at, is_anonymous)
        VALUES (${userId}, 'System User', ${userId + '@local'}, false, now(), now(), false)
        ON CONFLICT (id) DO NOTHING
      `).then(() => {
        seededUserIds.add(userId);
      }).catch(() => { /* table may not exist yet */ });
    } else {
      // better-sqlite3 driver is fully synchronous — no Promise returned.
      drizzleDb.run(sql`
        INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at, is_anonymous)
        VALUES (${userId}, 'System User', ${userId + '@local'}, 0, ${Date.now()}, ${Date.now()}, 0)
      `);
      seededUserIds.add(userId);
    }
  } catch {
    // Silently ignore – the user table may not exist yet on first boot before migrations run.
  }
}

function getDrizzleDB() {
  if (dbInstance) return dbInstance;

  dbIsPostgres = !!process.env.POSTGRES_URL;

  if (dbIsPostgres) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle: drizzlePg } = require('drizzle-orm/node-postgres');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.POSTGRES_URL,
    });
    dbInstance = drizzlePg(pool, { schema: { ...schema, ...authSchemaPostgres } });
  } else {
    // Fallback to SQLite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle: drizzleSqlite } = require('drizzle-orm/better-sqlite3');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const dbPath = path.join(process.cwd(), 'docstore', 'sqlite3.db');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const sqlite = new Database(dbPath);
    // WAL mode allows concurrent readers + writer without blocking each other.
    // busy_timeout retries on SQLITE_BUSY instead of failing immediately,
    // which prevents 500 errors under concurrent API requests (e.g. multiple
    // Playwright browser projects hitting the server simultaneously).
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    dbInstance = drizzleSqlite(sqlite, { schema: { ...schema, ...authSchemaSqlite } });
  }

  ensureSystemUserExists(UNCLAIMED_USER_ID);

  return dbInstance;
}

// Lazy proxy: the actual DB connection is only opened on first property access.
// This prevents side effects (e.g. creating an empty sqlite3.db) when modules
// import `db` but never use it, such as during Better Auth CLI schema generation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db: any = new Proxy({} as any, {
  get(_target, prop, receiver) {
    const instance = getDrizzleDB();
    const value = Reflect.get(instance, prop, receiver);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});

