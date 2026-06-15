CREATE TABLE `user_folders` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	PRIMARY KEY(`id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_folders_user_position` ON `user_folders` (`user_id`,`position`);--> statement-breakpoint
CREATE TABLE `user_onboarding` (
	`user_id` text PRIMARY KEY NOT NULL,
	`privacy_accepted_at_ms` integer,
	`last_seen_app_version` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_documents` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`last_modified` integer NOT NULL,
	`file_path` text NOT NULL,
	`folder_id` text,
	`recently_opened_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	PRIMARY KEY(`id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`,`user_id`) REFERENCES `user_folders`(`id`,`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_documents`("id", "user_id", "name", "type", "size", "last_modified", "file_path", "folder_id", "recently_opened_at", "created_at") SELECT "id", "user_id", "name", "type", "size", "last_modified", "file_path", NULL, NULL, "created_at" FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_documents_user_id` ON `documents` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_documents_user_id_last_modified` ON `documents` (`user_id`,`last_modified`);--> statement-breakpoint
CREATE INDEX `idx_documents_user_id_folder` ON `documents` (`user_id`,`folder_id`);--> statement-breakpoint
CREATE INDEX `idx_documents_user_id_recently_opened` ON `documents` (`user_id`,`recently_opened_at`);