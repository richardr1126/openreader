CREATE TABLE `audiobook_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`document_version` integer NOT NULL,
	`format` text NOT NULL,
	`speed` real NOT NULL,
	`chapter_index` integer,
	`settings_json` text NOT NULL,
	`plan_object_key` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`,`user_id`) REFERENCES `documents`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_audiobook_requests_user_document` ON `audiobook_requests` (`user_id`,`document_id`);