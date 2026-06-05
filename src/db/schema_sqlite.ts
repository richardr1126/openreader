import { sqliteTable, text, integer, real, primaryKey, index, foreignKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { user } from './schema_auth_sqlite';

const SQLITE_NOW_MS = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const documents = sqliteTable('documents', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // pdf, epub, docx, html
  size: integer('size').notNull(),
  lastModified: integer('last_modified').notNull(),
  filePath: text('file_path').notNull(),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
  index('idx_documents_user_id').on(table.userId),
  index('idx_documents_user_id_last_modified').on(table.userId, table.lastModified),
]);

export const audiobooks = sqliteTable('audiobooks', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  author: text('author'),
  description: text('description'),
  coverPath: text('cover_path'),
  duration: real('duration').default(0),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
]);

export const audiobookChapters = sqliteTable('audiobook_chapters', {
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

export const userTtsChars = sqliteTable("user_tts_chars", {
  userId: text('user_id').notNull(),
  date: text('date').notNull(), // SQLite doesn't have native DATE type, text YYYY-MM-DD is standard
  charCount: integer('char_count').default(0),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.userId, table.date] }),
  index('idx_user_tts_chars_date').on(table.date),
]);

// Generic per-user job-creation ledger for rate/concurrency limiting of
// expensive compute operations (e.g. PDF layout parsing). One row per created
// worker op. A trailing-window COUNT over (user_id, action) enforces both a
// short-window burst cap and a wider sustained/concurrency cap; because the
// worker bounds each op by a hard cap, "ops created in the last hard-cap
// window" is an upper bound on in-flight ops. Old rows are pruned opportunistically.
export const userJobEvents = sqliteTable('user_job_events', {
  userId: text('user_id').notNull(),
  action: text('action').notNull(),
  opId: text('op_id').notNull(),
  createdAt: integer('created_at').notNull().default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.userId, table.action, table.opId] }),
  index('idx_user_job_events_user_action_created').on(table.userId, table.action, table.createdAt),
]);

export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  dataJson: text('data_json').notNull().default('{}'),
  clientUpdatedAtMs: integer('client_updated_at_ms').notNull().default(0),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').default(SQLITE_NOW_MS),
});

export const documentSettings = sqliteTable('document_settings', {
  documentId: text('document_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  dataJson: text('data_json').notNull().default('{}'),
  clientUpdatedAtMs: integer('client_updated_at_ms').notNull().default(0),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.documentId, table.userId] }),
  index('idx_document_settings_user_id').on(table.userId),
]);

export const userDocumentProgress = sqliteTable('user_document_progress', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull(),
  readerType: text('reader_type').notNull(), // pdf, epub, html
  location: text('location').notNull(),
  progress: real('progress'),
  clientUpdatedAtMs: integer('client_updated_at_ms').notNull().default(0),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.userId, table.documentId] }),
  index('idx_user_document_progress_user_id_updated_at').on(table.userId, table.updatedAt),
]);

export const documentPreviews = sqliteTable('document_previews', {
  documentId: text('document_id').notNull(),
  namespace: text('namespace').notNull().default(''),
  variant: text('variant').notNull(),
  status: text('status').notNull().default('queued'),
  sourceLastModifiedMs: integer('source_last_modified_ms').notNull(),
  objectKey: text('object_key').notNull(),
  contentType: text('content_type').notNull().default('image/jpeg'),
  width: integer('width').notNull(),
  height: integer('height'),
  byteSize: integer('byte_size'),
  eTag: text('etag'),
  leaseOwner: text('lease_owner'),
  leaseUntilMs: integer('lease_until_ms').notNull().default(0),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  createdAtMs: integer('created_at_ms').notNull().default(0),
  updatedAtMs: integer('updated_at_ms').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.documentId, table.namespace, table.variant] }),
  index('idx_document_previews_status_lease').on(table.status, table.leaseUntilMs),
]);

export const ttsSegmentEntries = sqliteTable('tts_segment_entries', {
  segmentEntryId: text('segment_entry_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull(),
  readerType: text('reader_type').notNull(),
  documentVersion: integer('document_version').notNull(),
  segmentIndex: integer('segment_index').notNull(),
  segmentKey: text('segment_key'),
  locatorReaderRank: integer('locator_reader_rank').notNull(),
  locatorReaderType: text('locator_reader_type').notNull(),
  locatorPage: integer('locator_page').notNull(),
  locatorSpineIndex: integer('locator_spine_index').notNull(),
  locatorSpineHref: text('locator_spine_href').notNull(),
  locatorCharOffset: integer('locator_char_offset').notNull(),
  locatorLocation: text('locator_location').notNull(),
  locatorIdentityKey: text('locator_identity_key').notNull(),
  textHash: text('text_hash').notNull(),
  textLength: integer('text_length').notNull().default(0),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.segmentEntryId, table.userId] }),
  index('idx_tts_segment_entries_manifest_sort').on(
    table.userId,
    table.documentId,
    table.documentVersion,
    table.locatorReaderRank,
    table.locatorSpineIndex,
    table.locatorCharOffset,
    table.locatorSpineHref,
    table.locatorPage,
    table.locatorLocation,
    table.segmentIndex,
    table.locatorIdentityKey,
  ),
  index('idx_tts_segment_entries_manifest_group').on(
    table.userId,
    table.documentId,
    table.documentVersion,
    table.segmentIndex,
    table.locatorIdentityKey,
  ),
  index('idx_tts_segment_entries_scope').on(
    table.userId,
    table.documentId,
    table.documentVersion,
  ),
]);

export const adminProviders = sqliteTable('admin_providers', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  providerType: text('provider_type').notNull(),
  baseUrl: text('base_url'),
  apiKeyCiphertext: text('api_key_ciphertext').notNull(),
  apiKeyIv: text('api_key_iv').notNull(),
  apiKeyLast4: text('api_key_last4'),
  defaultModel: text('default_model'),
  defaultInstructions: text('default_instructions'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at').notNull().default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').notNull().default(SQLITE_NOW_MS),
});

export const adminSettings = sqliteTable('admin_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  source: text('source').notNull().default('admin'),
  updatedAt: integer('updated_at').notNull().default(SQLITE_NOW_MS),
});

export const ttsSegmentVariants = sqliteTable('tts_segment_variants', {
  segmentId: text('segment_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  segmentEntryId: text('segment_entry_id').notNull(),
  settingsHash: text('settings_hash').notNull(),
  settingsJson: text('settings_json').notNull(),
  audioKey: text('audio_key'),
  audioFormat: text('audio_format').notNull().default('mp3'),
  durationMs: integer('duration_ms'),
  alignmentJson: text('alignment_json'),
  status: text('status').notNull().default('pending'),
  error: text('error'),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.segmentId, table.userId] }),
  foreignKey({
    columns: [table.segmentEntryId, table.userId],
    foreignColumns: [ttsSegmentEntries.segmentEntryId, ttsSegmentEntries.userId],
  }).onDelete('cascade'),
  index('idx_tts_segment_variants_entry').on(table.userId, table.segmentEntryId, table.updatedAt),
  index('idx_tts_segment_variants_status').on(table.userId, table.status),
  index('idx_tts_segment_variants_unique_settings').on(table.userId, table.segmentEntryId, table.settingsHash),
]);
