import { sql } from 'drizzle-orm';
import { pgTable, text, integer, real, date, bigint, boolean, primaryKey, index, jsonb, foreignKey, check } from 'drizzle-orm/pg-core';
import { user } from './schema_auth_postgres';

const PG_NOW_MS = sql`(extract(epoch from now()) * 1000)::bigint`;

export const userFolders = pgTable('user_folders', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // bigint (not int4): folder `position` is written as a millisecond epoch
  // timestamp, which overflows a 32-bit integer. Matches created_at/updated_at.
  position: bigint('position', { mode: 'number' }).notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
  index('idx_user_folders_user_position').on(table.userId, table.position),
]);

export const documents = pgTable('documents', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // pdf, epub, docx, html
  size: bigint('size', { mode: 'number' }).notNull(),
  lastModified: bigint('last_modified', { mode: 'number' }).notNull(),
  filePath: text('file_path').notNull(),
  folderId: text('folder_id'),
  recentlyOpenedAt: bigint('recently_opened_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
  foreignKey({
    columns: [table.folderId, table.userId],
    foreignColumns: [userFolders.id, userFolders.userId],
  }),
  index('idx_documents_user_id').on(table.userId),
  index('idx_documents_user_id_last_modified').on(table.userId, table.lastModified),
  index('idx_documents_user_id_folder').on(table.userId, table.folderId),
  index('idx_documents_user_id_recently_opened').on(table.userId, table.recentlyOpenedAt),
]);

// Auth tables (user, session, account, verification) are managed by Better Auth.
// They are created/migrated via `@better-auth/cli migrate` and should NOT be
// defined here. Only application-specific tables belong in this file.

export const userTtsChars = pgTable("user_tts_chars", {
  // Also stores device:* and ip:* backstop buckets, so this cannot reference user.id.
  userId: text('user_id').notNull(),
  date: date('date').notNull(),
  charCount: bigint('char_count', { mode: 'number' }).default(0),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).default(PG_NOW_MS),
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
export const userJobEvents = pgTable('user_job_events', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  opId: text('op_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.userId, table.action, table.opId] }),
  index('idx_user_job_events_user_action_created').on(table.userId, table.action, table.createdAt),
]);

export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  dataJson: jsonb('data_json').notNull().default({}),
  clientUpdatedAtMs: bigint('client_updated_at_ms', { mode: 'number' }).notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).default(PG_NOW_MS),
});

export const userOnboarding = pgTable('user_onboarding', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  privacyAcceptedAtMs: bigint('privacy_accepted_at_ms', { mode: 'number' }),
  lastSeenAppVersion: text('last_seen_app_version'),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).default(PG_NOW_MS),
});

export const documentSettings = pgTable('document_settings', {
  documentId: text('document_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  dataJson: jsonb('data_json').notNull().default({}),
  clientUpdatedAtMs: bigint('client_updated_at_ms', { mode: 'number' }).notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.documentId, table.userId] }),
  index('idx_document_settings_user_id').on(table.userId),
]);

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
  variant: text('variant').notNull(),
  status: text('status').notNull().default('queued'),
  sourceLastModifiedMs: bigint('source_last_modified_ms', { mode: 'number' }).notNull(),
  objectKey: text('object_key').notNull(),
  contentType: text('content_type').notNull().default('image/jpeg'),
  width: integer('width').notNull(),
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

export const adminProviders = pgTable('admin_providers', {
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
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(PG_NOW_MS),
});

export const adminSettings = pgTable('admin_settings', {
  key: text('key').primaryKey(),
  valueJson: jsonb('value_json').notNull(),
  source: text('source').notNull().default('admin'),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(PG_NOW_MS),
});

export const scheduledTasks = pgTable('scheduled_tasks', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  intervalMs: bigint('interval_ms', { mode: 'number' }).notNull(),
  lastStatus: text('last_status').notNull().default('idle'),
  leaseOwner: text('lease_owner'),
  lastRunAt: bigint('last_run_at', { mode: 'number' }),
  lastDurationMs: bigint('last_duration_ms', { mode: 'number' }),
  lastError: text('last_error'),
  lastResultJson: text('last_result_json'),
  nextRunAt: bigint('next_run_at', { mode: 'number' }),
  runRequested: boolean('run_requested').notNull().default(false),
  runningSince: bigint('running_since', { mode: 'number' }),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(PG_NOW_MS),
}, (table) => [
  check('scheduled_tasks_interval_ms_positive', sql`${table.intervalMs} > 0`),
]);

export const documentBlobLeases = pgTable('document_blob_leases', {
  documentId: text('document_id').primaryKey(),
  leaseOwner: text('lease_owner').notNull(),
  leaseUntilMs: bigint('lease_until_ms', { mode: 'number' }).notNull(),
});
