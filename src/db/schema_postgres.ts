import { sql } from 'drizzle-orm';
import { pgTable, text, integer, real, date, bigint, primaryKey, index, jsonb, foreignKey } from 'drizzle-orm/pg-core';
import { user } from './schema_auth_postgres';

const PG_NOW_MS = sql`(extract(epoch from now()) * 1000)::bigint`;

export const documents = pgTable('documents', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // pdf, epub, docx, html
  size: bigint('size', { mode: 'number' }).notNull(),
  lastModified: bigint('last_modified', { mode: 'number' }).notNull(),
  filePath: text('file_path').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
  index('idx_documents_user_id').on(table.userId),
  index('idx_documents_user_id_last_modified').on(table.userId, table.lastModified),
]);

export const audiobooks = pgTable('audiobooks', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  author: text('author'),
  description: text('description'),
  coverPath: text('cover_path'),
  duration: real('duration').default(0),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
]);

export const audiobookChapters = pgTable('audiobook_chapters', {
  id: text('id').notNull(),
  bookId: text('book_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  chapterIndex: integer('chapter_index').notNull(),
  title: text('title').notNull(),
  duration: real('duration').default(0),
  filePath: text('file_path').notNull(),
  format: text('format').notNull(), // mp3, m4b
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
  foreignKey({
    columns: [table.bookId, table.userId],
    foreignColumns: [audiobooks.id, audiobooks.userId],
  }).onDelete('cascade'),
]);

// Auth tables (user, session, account, verification) are managed by Better Auth.
// They are created/migrated via `@better-auth/cli migrate` and should NOT be
// defined here. Only application-specific tables belong in this file.

export const userTtsChars = pgTable("user_tts_chars", {
  userId: text('user_id').notNull(),
  date: date('date').notNull(),
  charCount: bigint('char_count', { mode: 'number' }).default(0),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.userId, table.date] }),
  index('idx_user_tts_chars_date').on(table.date),
]);

export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  dataJson: jsonb('data_json').notNull().default({}),
  clientUpdatedAtMs: bigint('client_updated_at_ms', { mode: 'number' }).notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).default(PG_NOW_MS),
});

export const userDocumentProgress = pgTable('user_document_progress', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull(),
  readerType: text('reader_type').notNull(), // pdf, epub, html
  location: text('location').notNull(),
  progress: real('progress'),
  clientUpdatedAtMs: bigint('client_updated_at_ms', { mode: 'number' }).notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.userId, table.documentId] }),
  index('idx_user_document_progress_user_id_updated_at').on(table.userId, table.updatedAt),
]);

export const documentPreviews = pgTable('document_previews', {
  documentId: text('document_id').notNull(),
  namespace: text('namespace').notNull().default(''),
  variant: text('variant').notNull().default('card-240-jpeg'),
  status: text('status').notNull().default('queued'),
  sourceLastModifiedMs: bigint('source_last_modified_ms', { mode: 'number' }).notNull(),
  objectKey: text('object_key').notNull(),
  contentType: text('content_type').notNull().default('image/jpeg'),
  width: integer('width').notNull().default(240),
  height: integer('height'),
  byteSize: bigint('byte_size', { mode: 'number' }),
  eTag: text('etag'),
  leaseOwner: text('lease_owner'),
  leaseUntilMs: bigint('lease_until_ms', { mode: 'number' }).notNull().default(0),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull().default(0),
  updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.documentId, table.namespace, table.variant] }),
  index('idx_document_previews_status_lease').on(table.status, table.leaseUntilMs),
]);
