CREATE TABLE `user_document_bookmarks` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`reader_type` text NOT NULL,
	`location` text NOT NULL,
	`segment_key` text,
	`segment_ordinal` integer,
	`label` text,
	`snippet` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`,`user_id`) REFERENCES `documents`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_document_bookmarks_user_document` ON `user_document_bookmarks` (`user_id`,`document_id`);--> statement-breakpoint
ALTER TABLE `documents` ADD `author` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `language` text;