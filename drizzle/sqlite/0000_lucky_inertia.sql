CREATE TABLE `audiobook_chapters` (
	`id` text NOT NULL,
	`book_id` text NOT NULL,
	`user_id` text NOT NULL,
	`chapter_index` integer NOT NULL,
	`title` text NOT NULL,
	`duration` real DEFAULT 0,
	`file_path` text NOT NULL,
	`format` text NOT NULL,
	PRIMARY KEY(`id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`,`user_id`) REFERENCES `audiobooks`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audiobooks` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`description` text,
	`cover_path` text,
	`duration` real DEFAULT 0,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int) * 1000),
	PRIMARY KEY(`id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `document_previews` (
	`document_id` text NOT NULL,
	`namespace` text DEFAULT '' NOT NULL,
	`variant` text DEFAULT 'card-240-jpeg' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`source_last_modified_ms` integer NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text DEFAULT 'image/jpeg' NOT NULL,
	`width` integer DEFAULT 240 NOT NULL,
	`height` integer,
	`byte_size` integer,
	`etag` text,
	`lease_owner` text,
	`lease_until_ms` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at_ms` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`document_id`, `namespace`, `variant`)
);
--> statement-breakpoint
CREATE INDEX `idx_document_previews_status_lease` ON `document_previews` (`status`,`lease_until_ms`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`last_modified` integer NOT NULL,
	`file_path` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int) * 1000),
	PRIMARY KEY(`id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_documents_user_id` ON `documents` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_documents_user_id_last_modified` ON `documents` (`user_id`,`last_modified`);--> statement-breakpoint
CREATE TABLE `user_document_progress` (
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`reader_type` text NOT NULL,
	`location` text NOT NULL,
	`progress` real,
	`client_updated_at_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int) * 1000),
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int) * 1000),
	PRIMARY KEY(`user_id`, `document_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_document_progress_user_id_updated_at` ON `user_document_progress` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`client_updated_at_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int) * 1000),
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int) * 1000),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_tts_chars` (
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`char_count` integer DEFAULT 0,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int) * 1000),
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int) * 1000),
	PRIMARY KEY(`user_id`, `date`)
);
--> statement-breakpoint
CREATE INDEX `idx_user_tts_chars_date` ON `user_tts_chars` (`date`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`is_anonymous` integer DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);