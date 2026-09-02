CREATE TABLE `tts_playback_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`storage_user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`document_version` integer NOT NULL,
	`reader_type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`worker_op_id` text,
	`settings_hash` text NOT NULL,
	`settings_json` text NOT NULL,
	`start_ordinal` integer DEFAULT 0 NOT NULL,
	`cursor_ordinal` integer DEFAULT 0 NOT NULL,
	`cursor_updated_at` integer,
	`plan_object_key` text,
	`expires_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tts_playback_sessions_user_doc_settings` ON `tts_playback_sessions` (`user_id`,`document_id`,`document_version`,`settings_hash`,`start_ordinal`);--> statement-breakpoint
CREATE INDEX `idx_tts_playback_sessions_expiry` ON `tts_playback_sessions` (`expires_at`);