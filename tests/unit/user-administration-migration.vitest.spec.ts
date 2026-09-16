import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'packages/database/migrations/sqlite/0020_user_administration.sql'),
  'utf8',
);

function createLegacyDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(':memory:');
  database.exec(`
    CREATE TABLE user (
      id text PRIMARY KEY NOT NULL,
      is_admin integer NOT NULL DEFAULT 0
    );
    CREATE TABLE admin_settings (
      key text PRIMARY KEY NOT NULL,
      value_json text NOT NULL,
      source text NOT NULL,
      updated_at integer NOT NULL
    );
  `);
  return database;
}

describe('v5 user administration migration', () => {
  test('preserves a closed signup setting and existing admin grants', () => {
    const database = createLegacyDatabase();
    try {
      database.exec(`
        INSERT INTO user (id, is_admin) VALUES ('owner', 1), ('reader', 0);
        INSERT INTO admin_settings (key, value_json, source, updated_at)
        VALUES ('enableUserSignups', 'false', 'admin', 123);
      `);

      database.exec(migration);

      expect(database.prepare('SELECT id, is_admin, admin_source, access_status FROM user ORDER BY id').all()).toEqual([
        { id: 'owner', is_admin: 1, admin_source: 'managed', access_status: 'active' },
        { id: 'reader', is_admin: 0, admin_source: 'none', access_status: 'active' },
      ]);
      expect(database.prepare('SELECT value_json, source, updated_at FROM admin_settings WHERE key = ?').get('signupPolicy')).toEqual({
        value_json: '"closed"', source: 'admin', updated_at: 123,
      });
      expect(database.prepare('SELECT value_json FROM admin_settings WHERE key = ?').get('initialAdminBootstrapped')).toEqual({
        value_json: '{"version":1,"legacy":true}',
      });
    } finally {
      database.close();
    }
  });

  test('treats a JSON-string "false" signup setting as closed', () => {
    const database = createLegacyDatabase();
    try {
      database.exec(`
        INSERT INTO admin_settings (key, value_json, source, updated_at)
        VALUES ('enableUserSignups', '"false"', 'admin', 77);
      `);
      database.exec(migration);
      expect(database.prepare('SELECT value_json FROM admin_settings WHERE key = ?').get('signupPolicy')).toEqual({
        value_json: '"closed"',
      });
    } finally {
      database.close();
    }
  });

  test('preserves an open signup setting', () => {
    const database = createLegacyDatabase();
    try {
      database.exec(`
        INSERT INTO admin_settings (key, value_json, source, updated_at)
        VALUES ('enableUserSignups', 'true', 'json-seed', 99);
      `);
      database.exec(migration);
      expect(database.prepare('SELECT value_json, source FROM admin_settings WHERE key = ?').get('signupPolicy')).toEqual({
        value_json: '"open"',
        source: 'json-seed',
      });
    } finally {
      database.close();
    }
  });
});
