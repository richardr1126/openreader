PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_document_previews` (
	`document_id` text NOT NULL,
	`namespace` text DEFAULT '' NOT NULL,
	`variant` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`source_last_modified_ms` integer NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text DEFAULT 'image/jpeg' NOT NULL,
	`width` integer NOT NULL,
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
INSERT INTO `__new_document_previews`("document_id", "namespace", "variant", "status", "source_last_modified_ms", "object_key", "content_type", "width", "height", "byte_size", "etag", "lease_owner", "lease_until_ms", "attempt_count", "last_error", "created_at_ms", "updated_at_ms") SELECT "document_id", "namespace", "variant", "status", "source_last_modified_ms", "object_key", "content_type", "width", "height", "byte_size", "etag", "lease_owner", "lease_until_ms", "attempt_count", "last_error", "created_at_ms", "updated_at_ms" FROM `document_previews`;--> statement-breakpoint
DROP TABLE `document_previews`;--> statement-breakpoint
ALTER TABLE `__new_document_previews` RENAME TO `document_previews`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_document_previews_status_lease` ON `document_previews` (`status`,`lease_until_ms`);