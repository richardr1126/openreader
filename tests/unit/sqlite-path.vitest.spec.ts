import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { resolveSqliteDatabasePath } from '@openreader/database/sqlite-path';

describe('SQLite database path', () => {
  test('defaults to the workspace docstore', () => {
    expect(resolveSqliteDatabasePath('/srv/openreader', {}))
      .toBe(path.join('/srv/openreader', 'docstore', 'sqlite3.db'));
  });

  test('resolves a configured relative path against the application workspace', () => {
    expect(resolveSqliteDatabasePath('/srv/openreader', { SQLITE_DB_PATH: 'state/openreader.db' }))
      .toBe(path.join('/srv/openreader', 'state', 'openreader.db'));
  });

  test('preserves an absolute path shared with packaged child processes', () => {
    expect(resolveSqliteDatabasePath('/opt/openreader/embedded-compute-worker', {
      SQLITE_DB_PATH: '/app/docstore/sqlite3.db',
    })).toBe('/app/docstore/sqlite3.db');
  });

  test('bootstrap pins one absolute path before migrations and child startup', () => {
    const bootstrap = readFileSync(path.join(process.cwd(), 'packages/bootstrap/src/cli.mjs'), 'utf8');
    const pathSetup = bootstrap.indexOf('runtimeEnv.SQLITE_DB_PATH = withDefault(');
    const migrations = bootstrap.indexOf('await runDbMigrations(runtimeEnv)');
    const workerSpawn = bootstrap.indexOf('const workerEnv = {');

    expect(pathSetup).toBeGreaterThan(-1);
    expect(migrations).toBeGreaterThan(pathSetup);
    expect(workerSpawn).toBeGreaterThan(migrations);
  });
});
