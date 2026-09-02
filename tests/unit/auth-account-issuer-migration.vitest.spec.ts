import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const migrationSql = readFileSync(
  join(
    process.cwd(),
    'packages/database/migrations/sqlite/0016_account_identity_issuer.sql',
  ),
  'utf8',
);

function createV4AuthDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3(':memory:');
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE user (
      id text PRIMARY KEY NOT NULL
    );
    CREATE TABLE account (
      id text PRIMARY KEY NOT NULL,
      account_id text NOT NULL,
      provider_id text NOT NULL,
      user_id text NOT NULL,
      access_token text,
      refresh_token text,
      id_token text,
      access_token_expires_at integer,
      refresh_token_expires_at integer,
      scope text,
      password text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE cascade
    );
    CREATE INDEX account_userId_idx ON account(user_id);
  `);
  return database;
}

function insertAccount(
  database: BetterSqlite3.Database,
  input: { id: string; accountId: string; providerId: string; userId: string },
): void {
  database.prepare(`
    INSERT INTO user (id) VALUES (?)
  `).run(input.userId);
  database.prepare(`
    INSERT INTO account (
      id, account_id, provider_id, user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 1)
  `).run(input.id, input.accountId, input.providerId, input.userId);
}

describe('Better Auth 1.7 account identity migration', () => {
  test('backfills v4 credential and GitHub identities before enforcing uniqueness', () => {
    const database = createV4AuthDatabase();
    try {
      insertAccount(database, {
        id: 'credential-account',
        accountId: 'legacy-email-derived-account-id',
        providerId: 'credential',
        userId: 'credential-user',
      });
      insertAccount(database, {
        id: 'github-account',
        accountId: 'github-user-123',
        providerId: 'github',
        userId: 'github-user',
      });

      database.exec(migrationSql);

      expect(database.prepare(`
        SELECT id, account_id AS accountId, provider_id AS providerId, issuer
        FROM account
        ORDER BY id
      `).all()).toEqual([
        {
          id: 'credential-account',
          accountId: 'credential-user',
          providerId: 'credential',
          issuer: 'local:credential',
        },
        {
          id: 'github-account',
          accountId: 'github-user-123',
          providerId: 'github',
          issuer: 'local:oauth:github',
        },
      ]);

      const issuerColumn = database.prepare('PRAGMA table_info(account)').all()
        .find((column) => (column as { name: string }).name === 'issuer') as {
          notnull: number;
        } | undefined;
      expect(issuerColumn?.notnull).toBe(1);

      const indexes = database.prepare('PRAGMA index_list(account)').all() as Array<{
        name: string;
        unique: number;
      }>;
      expect(indexes).toContainEqual(expect.objectContaining({
        name: 'account_issuer_accountId_uidx',
        unique: 1,
      }));
    } finally {
      database.close();
    }
  });

  test('fails closed instead of inventing an issuer for an unsupported v4 provider', () => {
    const database = createV4AuthDatabase();
    try {
      insertAccount(database, {
        id: 'unsupported-account',
        accountId: 'external-id',
        providerId: 'unsupported-provider',
        userId: 'unsupported-user',
      });

      expect(() => database.exec(migrationSql)).toThrow(/NOT NULL constraint failed/);
    } finally {
      database.close();
    }
  });
});
