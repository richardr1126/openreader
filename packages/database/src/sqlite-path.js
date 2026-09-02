import path from 'node:path';

/**
 * Resolve the SQLite database path against the application workspace. Keeping
 * this independent of process.cwd() lets packaged child processes share the
 * database migrated by the bootstrap process.
 * @param {string} workspaceRoot
 * @param {Record<string, string | undefined>} env
 */
export function resolveSqliteDatabasePath(workspaceRoot, env = process.env) {
  const configuredPath = env.SQLITE_DB_PATH?.trim();
  return configuredPath
    ? path.resolve(workspaceRoot, configuredPath)
    : path.join(workspaceRoot, 'docstore', 'sqlite3.db');
}
