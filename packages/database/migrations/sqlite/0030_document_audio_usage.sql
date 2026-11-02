CREATE TABLE `document_audio_usage` (
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`audio_bytes` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`clear_lease_until` integer DEFAULT 0 NOT NULL,
	`measured_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `document_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "document_audio_usage_nonnegative" CHECK("document_audio_usage"."audio_bytes" >= 0)
);
