CREATE TABLE `document_settings` (
	`document_id` text NOT NULL,
	`user_id` text NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`client_updated_at_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	PRIMARY KEY(`document_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_document_settings_user_id` ON `document_settings` (`user_id`);--> statement-breakpoint
ALTER TABLE `documents` ADD `parse_status` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `parsed_json_key` text;
