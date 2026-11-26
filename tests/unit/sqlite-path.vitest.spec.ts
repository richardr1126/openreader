import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { resolveSqliteDatabasePath } from '@openreader/database/sqlite-path';

// Absolute on every platform, including a drive letter on Windows.
const workspace = path.resolve('/srv/openreader');

describe('SQLite database path', () => {
  test('defaults to the workspace docstore', () => {
    expect(resolveSqliteDatabasePath(workspace, {}))
      .toBe(path.join(workspace, 'docstore', 'sqlite3.db'));
  });

  test('resolves a configured relative path against the application workspace', () => {
    expect(resolveSqliteDatabasePath(workspace, { SQLITE_DB_PATH: 'state/openreader.db' }))
      .toBe(path.join(workspace, 'state', 'openreader.db'));
  });

  test('preserves an absolute path shared with packaged child processes', () => {
    const shared = path.resolve('/app/docstore/sqlite3.db');
    expect(resolveSqliteDatabasePath(path.resolve('/opt/openreader/embedded-compute-worker'), {
      SQLITE_DB_PATH: shared,
    })).toBe(shared);
  });

  test('bootstrap pins one absolute path before migrations and child startup', () => {
    const bootstrap = readFileSync(path.join(process.cwd(), 'packages/bootstrap/src/cli.mjs'), 'utf8');
    const pathSetup = bootstrap.indexOf('runtimeEnv.SQLITE_DB_PATH = withDefault(');
    const migrations = bootstrap.indexOf('await runDbMigrations(runtimeEnv)');
    const workerSpawn = bootstrap.indexOf('const workerEnv = embeddedServiceEnv(runtimeEnv, {');

    expect(pathSetup).toBeGreaterThan(-1);
    expect(migrations).toBeGreaterThan(pathSetup);
    expect(workerSpawn).toBeGreaterThan(migrations);
  });
});
