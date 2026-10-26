import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, describe, expect, test } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'openreader-deepinfra-removal-'));
const databasePath = join(directory, 'app.db');

function migrateThrough(tag?: string): void {
  const source = join(process.cwd(), 'packages/database/migrations/sqlite');
  const folder = join(directory, tag ?? 'all');
  cpSync(source, folder, { recursive: true });
  if (tag) {
    const journalPath = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const end = journal.entries.findIndex((entry) => entry.tag === tag);
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, end + 1) }));
  }
  const sqlite = new Database(databasePath);
  try { migrate(drizzle(sqlite), { migrationsFolder: folder }); } finally { sqlite.close(); }
}

function insertProvider(sqlite: Database.Database, slug: string, providerType: string): void {
  sqlite.prepare(`insert into admin_providers (id, slug, display_name, provider_type, api_key_ciphertext, api_key_iv)
    values (?, ?, ?, ?, '', '')`).run(slug, slug, slug, providerType);
}

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('deepinfra provider removal', () => {
  test('removes deepinfra providers and a default that named one', () => {
    migrateThrough('0024_provider_model_options');
    const sqlite = new Database(databasePath);
    try {
      insertProvider(sqlite, 'old-deepinfra', 'deepinfra');
      insertProvider(sqlite, 'openai', 'openai');
      sqlite.prepare(`insert into admin_settings (key, value_json) values ('defaultTtsProvider', ?)`)
        .run(JSON.stringify('old-deepinfra'));
    } finally { sqlite.close(); }

    migrateThrough();

    const after = new Database(databasePath, { readonly: true });
    try {
      expect(after.prepare('select slug from admin_providers').all()).toEqual([{ slug: 'openai' }]);
      expect(after.prepare(`select key from admin_settings where key = 'defaultTtsProvider'`).all()).toEqual([]);
    } finally { after.close(); }
  });
});
