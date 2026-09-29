import fs from 'node:fs';
import { resolveSqliteDatabasePath } from '@openreader/database/sqlite-path';

// Created by every v4 schema and dropped by migration 0015, so its presence before
// migrations run identifies a database that has not been upgraded to v5 yet.
const V4_MARKER_TABLE = 'audiobooks';

/**
 * Reports whether the configured database still has the v4 schema. Never throws:
 * this only drives an informational notice and must not block startup.
 * @param {{ workspaceRoot: string, env?: Record<string, string | undefined> }} options
 */
export async function detectPreV5Database({ workspaceRoot, env = process.env }) {
  try {
    if (env.POSTGRES_URL?.trim()) {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ connectionString: env.POSTGRES_URL });
      try {
        const result = await pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${V4_MARKER_TABLE}`]);
        return result.rows[0]?.present === true;
      } finally {
        await pool.end();
      }
    }

    const dbPath = resolveSqliteDatabasePath(workspaceRoot, env);
    if (!fs.existsSync(dbPath)) return false;
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    const sqlite = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    try {
      return Boolean(sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(V4_MARKER_TABLE));
    } finally {
      sqlite.close();
    }
  } catch {
    return false;
  }
}

export function formatV4UpgradeNotice() {
  return [
    'Upgrading from OpenReader v4: this database has not been migrated to v5 yet.',
    '  - Migrations run now and cannot be reversed. If you have not backed up your database and storage, stop and do that first.',
    '  - v4 audiobooks and the v4 TTS audio cache are permanently deleted during this upgrade. Regenerate audiobooks from the reader afterward.',
    '  - ADMIN_EMAILS is no longer used. Existing administrators keep their access.',
    '  - Playback audio is served by the compute worker: publish port 8081 and, off localhost, set COMPUTE_WORKER_PUBLIC_URL.',
    '  - Step-by-step guide: https://docs.openreader.richardr.dev/deploy/upgrade-from-v4',
  ].join('\n');
}
