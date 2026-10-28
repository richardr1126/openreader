CREATE TABLE `storage_cleanups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text,
	`not_before_ms` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_storage_cleanups_not_before` ON `storage_cleanups` (`not_before_ms`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_document_settings` (
	`document_id` text NOT NULL,
	`user_id` text NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`client_updated_at_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	PRIMARY KEY(`document_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`,`user_id`) REFERENCES `documents`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_document_settings`("document_id", "user_id", "data_json", "client_updated_at_ms", "created_at", "updated_at") SELECT s."document_id", s."user_id", "data_json", "client_updated_at_ms", "created_at", "updated_at" FROM `document_settings` s WHERE EXISTS (SELECT 1 FROM `documents` d WHERE d.`id` = s.`document_id` AND d.`user_id` = s.`user_id`);--> statement-breakpoint
DROP TABLE `document_settings`;--> statement-breakpoint
ALTER TABLE `__new_document_settings` RENAME TO `document_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_document_settings_user_id` ON `document_settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_user_document_progress` (
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`segment_key` text,
	`segment_ordinal` integer DEFAULT 0 NOT NULL,
	`progress` real,
	`client_updated_at_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	PRIMARY KEY(`user_id`, `document_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`,`user_id`) REFERENCES `documents`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_document_progress`("user_id", "document_id", "segment_key", "segment_ordinal", "progress", "client_updated_at_ms", "created_at", "updated_at") SELECT "user_id", "document_id", "segment_key", "segment_ordinal", "progress", "client_updated_at_ms", "created_at", "updated_at" FROM `user_document_progress` p WHERE EXISTS (SELECT 1 FROM `documents` d WHERE d.`id` = p.`document_id` AND d.`user_id` = p.`user_id`);--> statement-breakpoint
DROP TABLE `user_document_progress`;--> statement-breakpoint
ALTER TABLE `__new_user_document_progress` RENAME TO `user_document_progress`;--> statement-breakpoint
CREATE INDEX `idx_user_document_progress_user_id_updated_at` ON `user_document_progress` (`user_id`,`updated_at`);