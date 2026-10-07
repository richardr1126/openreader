import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import {
  documentSettings,
  documents,
  userDocumentBookmarks,
} from '@openreader/database/schema-sqlite';
import { transferUserDocumentSettings, transferUserDocuments } from '../../src/lib/server/user/claim-data';

describe('transferUserDocuments', () => {
  test('moves document rows to new user without PK conflicts', async () => {
    process.env.BASE_URL = 'http://localhost:3003';
    process.env.AUTH_SECRET = 'test-secret';

    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE documents (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        last_modified INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        folder_id TEXT,
        recently_opened_at INTEGER,
        parse_state TEXT,
        parsed_json_key TEXT,
        author TEXT,
        language TEXT,
        created_at INTEGER,
        PRIMARY KEY (id, user_id)
      );
      CREATE TABLE user_document_bookmarks (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        segment_key TEXT NOT NULL,
        segment_ordinal INTEGER NOT NULL,
        label TEXT,
        snippet TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (id, user_id),
        FOREIGN KEY (document_id, user_id) REFERENCES documents(id, user_id) ON DELETE cascade
      );
    `);

    const db = drizzle(sqlite);

    const fromUserId = 'anon';
    const toUserId = 'user';

    await db.insert(documents).values([
      {
        id: 'doc-a',
        userId: fromUserId,
        name: 'a.pdf',
        type: 'pdf',
        size: 1,
        lastModified: 1,
        filePath: 'doc-a__a.pdf',
      },
      {
        id: 'doc-b',
        userId: fromUserId,
        name: 'b.txt',
        type: 'html',
        size: 2,
        lastModified: 2,
        filePath: 'doc-b__b.txt',
      },
      // Existing row for the destination user (conflict on insert)
      {
        id: 'doc-a',
        userId: toUserId,
        name: 'a.pdf',
        type: 'pdf',
        size: 1,
        lastModified: 1,
        filePath: 'doc-a__a.pdf',
      },
    ]);

    await db.insert(userDocumentBookmarks).values({
      id: 'mark-1',
      userId: fromUserId,
      documentId: 'doc-b',
      segmentKey: 'v7:kept',
      segmentOrdinal: 0,
      snippet: 'Kept across the claim',
    });

    const transferred = await transferUserDocuments(fromUserId, toUserId, { db });
    expect(transferred).toBe(2);

    const remainingFrom = await db.select().from(documents).where(eq(documents.userId, fromUserId));
    expect(remainingFrom.length).toBe(0);

    const remainingTo = await db.select().from(documents).where(eq(documents.userId, toUserId));
    const ids = remainingTo.map((r) => r.id).sort();
    expect(ids).toEqual(['doc-a', 'doc-b']);

    // The source document row cascades its bookmarks, so they must move first.
    const bookmarks = await db.select().from(userDocumentBookmarks);
    expect(bookmarks.map((row) => [row.id, row.userId, row.documentId])).toEqual([['mark-1', toUserId, 'doc-b']]);
  });

  test('moves document settings while preserving newer destination settings', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE document_settings (
        document_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        client_updated_at_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        PRIMARY KEY (document_id, user_id)
      );
    `);
    const settingsDb = drizzle(sqlite);

    await settingsDb.insert(documentSettings).values([
      {
        documentId: 'doc-newer-anon',
        userId: 'anon',
        dataJson: '{"source":"anon"}',
        clientUpdatedAtMs: 20,
      },
      {
        documentId: 'doc-newer-user',
        userId: 'anon',
        dataJson: '{"source":"anon"}',
        clientUpdatedAtMs: 10,
      },
      {
        documentId: 'doc-newer-user',
        userId: 'user',
        dataJson: '{"source":"user"}',
        clientUpdatedAtMs: 30,
      },
    ]);

    const transferred = await transferUserDocumentSettings('anon', 'user', {
      db: settingsDb,
    });
    expect(transferred).toBe(2);

    const rows = await settingsDb.select().from(documentSettings);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: 'doc-newer-anon',
        userId: 'user',
        dataJson: '{"source":"anon"}',
        clientUpdatedAtMs: 20,
      }),
      expect.objectContaining({
        documentId: 'doc-newer-user',
        userId: 'user',
        dataJson: '{"source":"user"}',
        clientUpdatedAtMs: 30,
      }),
    ]));
  });
});
