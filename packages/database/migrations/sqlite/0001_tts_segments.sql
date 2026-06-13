CREATE TABLE `tts_segments` (
	`segment_id` text NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`reader_type` text NOT NULL,
	`document_version` integer NOT NULL,
	`segment_index` integer NOT NULL,
	`locator_json` text,
	`settings_hash` text NOT NULL,
	`settings_json` text NOT NULL,
	`text_hash` text NOT NULL,
	`text_length` integer DEFAULT 0 NOT NULL,
	`audio_key` text,
	`audio_format` text DEFAULT 'mp3' NOT NULL,
	`duration_ms` integer,
	`alignment_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
	PRIMARY KEY(`segment_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tts_segments_lookup` ON `tts_segments` (`user_id`,`document_id`,`document_version`,`settings_hash`);--> statement-breakpoint
CREATE INDEX `idx_tts_segments_doc_index` ON `tts_segments` (`user_id`,`document_id`,`segment_index`);