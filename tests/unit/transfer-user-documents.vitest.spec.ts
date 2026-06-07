import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import {
  documentSettings,
  documents,
  ttsSegmentEntries,
  ttsSegmentVariants,
} from '../../src/db/schema_sqlite';
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
        parse_state TEXT,
        parsed_json_key TEXT,
        created_at INTEGER,
        PRIMARY KEY (id, user_id)
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

    const transferred = await transferUserDocuments(fromUserId, toUserId, { db });
    expect(transferred).toBe(2);

    const remainingFrom = await db.select().from(documents).where(eq(documents.userId, fromUserId));
    expect(remainingFrom.length).toBe(0);

    const remainingTo = await db.select().from(documents).where(eq(documents.userId, toUserId));
    const ids = remainingTo.map((r) => r.id).sort();
    expect(ids).toEqual(['doc-a', 'doc-b']);
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

  test('moves TTS metadata without requiring S3', async () => {
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
        parse_state TEXT,
        parsed_json_key TEXT,
        created_at INTEGER,
        PRIMARY KEY (id, user_id)
      );
      CREATE TABLE tts_segment_entries (
        segment_entry_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        reader_type TEXT NOT NULL,
        document_version INTEGER NOT NULL,
        segment_index INTEGER NOT NULL,
        segment_key TEXT,
        locator_reader_rank INTEGER NOT NULL,
        locator_reader_type TEXT NOT NULL,
        locator_page INTEGER NOT NULL,
        locator_spine_index INTEGER NOT NULL,
        locator_spine_href TEXT NOT NULL,
        locator_char_offset INTEGER NOT NULL,
        locator_location TEXT NOT NULL,
        locator_identity_key TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        text_length INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        PRIMARY KEY (segment_entry_id, user_id)
      );
      CREATE TABLE tts_segment_variants (
        segment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        segment_entry_id TEXT NOT NULL,
        settings_hash TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        audio_key TEXT,
        audio_format TEXT NOT NULL DEFAULT 'mp3',
        duration_ms INTEGER,
        alignment_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        PRIMARY KEY (segment_id, user_id)
      );
    `);
    const transferDb = drizzle(sqlite);

    await transferDb.insert(documents).values({
      id: 'doc',
      userId: 'anon',
      name: 'doc.pdf',
      type: 'pdf',
      size: 1,
      lastModified: 1,
      filePath: 'doc__doc.pdf',
    });
    await transferDb.insert(ttsSegmentEntries).values({
      segmentEntryId: 'entry',
      userId: 'anon',
      documentId: 'doc',
      readerType: 'pdf',
      documentVersion: 1,
      segmentIndex: 0,
      locatorReaderRank: 0,
      locatorReaderType: 'pdf',
      locatorPage: 1,
      locatorSpineIndex: 0,
      locatorSpineHref: '',
      locatorCharOffset: 0,
      locatorLocation: '1',
      locatorIdentityKey: 'page:1',
      textHash: 'hash',
    });
    await transferDb.insert(ttsSegmentVariants).values({
      segmentId: 'segment',
      userId: 'anon',
      segmentEntryId: 'entry',
      settingsHash: 'settings',
      settingsJson: '{}',
      audioKey: 'openreader/tts_segments_v2/users/anon/docs/doc/1/settings/segment.mp3',
      status: 'completed',
    });

    await transferUserDocuments('anon', 'user', {
      db: transferDb,
      transferTts: true,
      skipStorage: true,
    });

    expect(await transferDb.select().from(ttsSegmentEntries)).toEqual([
      expect.objectContaining({ segmentEntryId: 'entry', userId: 'user', documentId: 'doc' }),
    ]);
    expect(await transferDb.select().from(ttsSegmentVariants)).toEqual([
      expect.objectContaining({
        segmentId: 'segment',
        userId: 'user',
        audioKey: 'openreader/tts_segments_v2/users/user/docs/doc/1/settings/segment.mp3',
      }),
    ]);
  });
});
