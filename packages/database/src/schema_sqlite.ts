import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex, foreignKey, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { user } from './schema_auth_sqlite';

const SQLITE_NOW_MS = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const userFolders = sqliteTable('user_folders', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
  index('idx_user_folders_user_position').on(table.userId, table.position),
]);

export const documents = sqliteTable('documents', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // pdf, epub, docx, html
  size: integer('size').notNull(),
  lastModified: integer('last_modified').notNull(),
  filePath: text('file_path').notNull(),
  folderId: text('folder_id'),
  recentlyOpenedAt: integer('recently_opened_at'),
  // Bibliographic metadata captured at import time (EPUB/PDF metadata,
  // catalog or article byline, detected text language). Null when unknown;
  // documents imported before these columns existed are not backfilled.
  author: text('author'),
  language: text('language'),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
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

export const computeLimitAdmissions = sqliteTable('compute_limit_admissions', {
  id: text('id').primaryKey(),
  requestKey: text('request_key').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  isAnonymous: integer('is_anonymous', { mode: 'boolean' }).notNull(),
  action: text('action').notNull(),
  state: text('state').notNull(),
  operationId: text('operation_id'),
  deviceScopeKey: text('device_scope_key'),
  ipScopeKey: text('ip_scope_key'),
  activeScopesJson: text('active_scopes_json').notNull().default('[]'),
  policyVersion: integer('policy_version').notNull(),
  createdAt: integer('created_at').notNull(),
  activatedAt: integer('activated_at'),
  finishedAt: integer('finished_at'),
  leaseExpiresAt: integer('lease_expires_at').notNull(),
}, (table) => [
  uniqueIndex('compute_limit_admissions_request_unique').on(table.userId, table.action, table.requestKey),
  index('compute_limit_admissions_user_active').on(table.userId, table.action, table.state, table.leaseExpiresAt),
  index('compute_limit_admissions_action_active').on(table.action, table.state, table.leaseExpiresAt),
  index('compute_limit_admissions_operation').on(table.operationId),
  check('compute_limit_admissions_state_valid', sql`${table.state} in ('reserved', 'active', 'finished', 'cancelled')`),
]);

export const computeLimitBuckets = sqliteTable('compute_limit_buckets', {
  scopeType: text('scope_type').notNull(),
  scopeKey: text('scope_key').notNull(),
  action: text('action').notNull(),
  metric: text('metric').notNull(),
  windowStart: integer('window_start').notNull(),
  windowEnd: integer('window_end').notNull(),
  used: integer('used').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.scopeType, table.scopeKey, table.action, table.metric, table.windowStart] }),
  index('compute_limit_buckets_expiry').on(table.windowEnd, table.metric),
  check('compute_limit_buckets_used_nonnegative', sql`${table.used} >= 0`),
]);

export const computeLimitEvents = sqliteTable('compute_limit_events', {
  eventKey: text('event_key').primaryKey(),
  admissionId: text('admission_id').references(() => computeLimitAdmissions.id, { onDelete: 'set null' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  metric: text('metric').notNull(),
  units: integer('units').notNull(),
  policyVersion: integer('policy_version').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('compute_limit_events_user_action_created').on(table.userId, table.action, table.createdAt),
  index('compute_limit_events_created').on(table.createdAt),
  check('compute_limit_events_units_positive', sql`${table.units} > 0`),
]);

export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  dataJson: text('data_json').notNull().default('{}'),
  clientUpdatedAtMs: integer('client_updated_at_ms').notNull().default(0),
  createdAt: integer('created_at').default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').default(SQLITE_NOW_MS),
});

export const userOnboarding = sqliteTable('user_onboarding', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  privacyAcceptedAtMs: integer('privacy_accepted_at_ms'),
  lastSeenAppVersion: text('last_seen_app_version'),
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

// Personal bookmarks. `location` uses the same per-reader encoding as
// user_document_progress.location (EPUB stores the serialized progress
// locator). `segment_key`/`segment_ordinal` anchor the bookmarked sentence in
// the canonical playback plan when one was known: the key is content identity
// and survives re-planning, the ordinal is only a hint. Rows are hard-deleted
// and cascade with the owning document row.
export const userDocumentBookmarks = sqliteTable('user_document_bookmarks', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull(),
  readerType: text('reader_type').notNull(), // pdf, epub, html
  location: text('location').notNull(),
  segmentKey: text('segment_key'),
  segmentOrdinal: integer('segment_ordinal'),
  label: text('label'),
  snippet: text('snippet').notNull().default(''),
  createdAt: integer('created_at').notNull().default(SQLITE_NOW_MS),
  updatedAt: integer('updated_at').notNull().default(SQLITE_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
  foreignKey({
    name: 'user_document_bookmarks_document_fk',
    columns: [table.documentId, table.userId],
    foreignColumns: [documents.id, documents.userId],
  }).onDelete('cascade'),
  index('idx_user_document_bookmarks_user_document').on(table.userId, table.documentId),
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

export const scheduledTasks = sqliteTable('scheduled_tasks', {
  key: text('key').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  intervalMs: integer('interval_ms').notNull(),
  lastStatus: text('last_status').notNull().default('idle'),
  leaseOwner: text('lease_owner'),
  lastRunAt: integer('last_run_at'),
  lastDurationMs: integer('last_duration_ms'),
  lastError: text('last_error'),
  lastResultJson: text('last_result_json'),
  nextRunAt: integer('next_run_at'),
  runRequested: integer('run_requested', { mode: 'boolean' }).notNull().default(false),
  runningSince: integer('running_since'),
  updatedAt: integer('updated_at').notNull().default(SQLITE_NOW_MS),
}, (table) => [
  check('scheduled_tasks_interval_ms_positive', sql`${table.intervalMs} > 0`),
]);

export const documentBlobLeases = sqliteTable('document_blob_leases', {
  documentId: text('document_id').primaryKey(),
  leaseOwner: text('lease_owner').notNull(),
  leaseUntilMs: integer('lease_until_ms').notNull(),
});
