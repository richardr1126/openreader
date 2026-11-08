import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    sqliteDbPath: string;
  }
}

const migrationsFolder = fileURLToPath(new URL('../../packages/database/migrations/sqlite', import.meta.url));

/** Specs write real rows, so each run gets its own migrated database, never the dev one. */
export default function setup(project: TestProject) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openreader-vitest-'));
  const databasePath = path.join(directory, 'sqlite3.db');
  const sqlite = new Database(databasePath);
  migrate(drizzle(sqlite), { migrationsFolder });
  sqlite.close();
  project.provide('sqliteDbPath', databasePath);
  return () => fs.rmSync(directory, { recursive: true, force: true });
}
