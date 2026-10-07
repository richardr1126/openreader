import { sql } from 'drizzle-orm';
import { pgTable, text, integer, real, bigint, boolean, primaryKey, index, uniqueIndex, jsonb, foreignKey, check } from 'drizzle-orm/pg-core';
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
  // Bibliographic metadata captured at import time (EPUB/PDF metadata,
  // catalog or article byline, detected text language). Null when unknown;
  // documents imported before these columns existed are not backfilled.
  author: text('author'),
  language: text('language'),
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

export const computeLimitAdmissions = pgTable('compute_limit_admissions', {
  id: text('id').primaryKey(),
  requestKey: text('request_key').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  isAnonymous: boolean('is_anonymous').notNull(),
  action: text('action').notNull(),
  state: text('state').notNull(),
  operationId: text('operation_id'),
  deviceScopeKey: text('device_scope_key'),
  ipScopeKey: text('ip_scope_key'),
  activeScopesJson: text('active_scopes_json').notNull().default('[]'),
  policyVersion: bigint('policy_version', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  activatedAt: bigint('activated_at', { mode: 'number' }),
  finishedAt: bigint('finished_at', { mode: 'number' }),
  leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }).notNull(),
}, (table) => [
  uniqueIndex('compute_limit_admissions_request_unique').on(table.userId, table.action, table.requestKey),
  index('compute_limit_admissions_user_active').on(table.userId, table.action, table.state, table.leaseExpiresAt),
  index('compute_limit_admissions_action_active').on(table.action, table.state, table.leaseExpiresAt),
  index('compute_limit_admissions_operation').on(table.operationId),
  check('compute_limit_admissions_state_valid', sql`${table.state} in ('reserved', 'active', 'finished', 'cancelled')`),
]);

export const computeLimitBuckets = pgTable('compute_limit_buckets', {
  scopeType: text('scope_type').notNull(),
  scopeKey: text('scope_key').notNull(),
  action: text('action').notNull(),
  metric: text('metric').notNull(),
  windowStart: bigint('window_start', { mode: 'number' }).notNull(),
  windowEnd: bigint('window_end', { mode: 'number' }).notNull(),
  used: bigint('used', { mode: 'number' }).notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.scopeType, table.scopeKey, table.action, table.metric, table.windowStart] }),
  index('compute_limit_buckets_expiry').on(table.windowEnd, table.metric),
  check('compute_limit_buckets_used_nonnegative', sql`${table.used} >= 0`),
]);

export const computeLimitEvents = pgTable('compute_limit_events', {
  eventKey: text('event_key').primaryKey(),
  admissionId: text('admission_id').references(() => computeLimitAdmissions.id, { onDelete: 'set null' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  metric: text('metric').notNull(),
  units: bigint('units', { mode: 'number' }).notNull(),
  policyVersion: bigint('policy_version', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => [
  index('compute_limit_events_user_action_created').on(table.userId, table.action, table.createdAt),
  index('compute_limit_events_created').on(table.createdAt),
  check('compute_limit_events_units_positive', sql`${table.units} > 0`),
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
  // The playback cursor: content identity plus an ordinal hint, resolved
  // against the current plan (`resolveReadingPositionOrdinal`). Pages and
  // chapters are derived from it, never stored. A null key (rows converted
  // from the v5.0 page/location format) resolves by ordinal alone.
  segmentKey: text('segment_key'),
  segmentOrdinal: integer('segment_ordinal').notNull().default(0),
  progress: real('progress'),
  clientUpdatedAtMs: bigint('client_updated_at_ms', { mode: 'number' }).notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.userId, table.documentId] }),
  index('idx_user_document_progress_user_id_updated_at').on(table.userId, table.updatedAt),
]);

// Personal bookmarks, positioned exactly like reading progress: the segment
// key is content identity and survives re-planning, the ordinal is a hint.
// Rows are hard-deleted and cascade with the owning document row.
export const userDocumentBookmarks = pgTable('user_document_bookmarks', {
  id: text('id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull(),
  segmentKey: text('segment_key').notNull(),
  segmentOrdinal: integer('segment_ordinal').notNull(),
  label: text('label'),
  snippet: text('snippet').notNull().default(''),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(PG_NOW_MS),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(PG_NOW_MS),
}, (table) => [
  primaryKey({ columns: [table.id, table.userId] }),
  foreignKey({
    name: 'user_document_bookmarks_document_fk',
    columns: [table.documentId, table.userId],
    foreignColumns: [documents.id, documents.userId],
  }).onDelete('cascade'),
  index('idx_user_document_bookmarks_user_document').on(table.userId, table.documentId),
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
