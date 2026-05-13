CREATE TABLE `admin_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`provider_type` text NOT NULL,
	`base_url` text,
	`api_key_ciphertext` text NOT NULL,
	`api_key_iv` text NOT NULL,
	`api_key_last4` text,
	`default_model` text,
	`default_instructions` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_providers_slug_unique` ON `admin_providers` (`slug`);--> statement-breakpoint
CREATE TABLE `admin_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`source` text DEFAULT 'admin' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `user` ADD `is_admin` integer DEFAULT false NOT NULL;