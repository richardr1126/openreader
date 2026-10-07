CREATE TABLE `user_document_bookmarks` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`segment_key` text NOT NULL,
	`segment_ordinal` integer NOT NULL,
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
ALTER TABLE `documents` ADD `language` text;--> statement-breakpoint
ALTER TABLE `user_document_progress` ADD `segment_key` text;--> statement-breakpoint
ALTER TABLE `user_document_progress` ADD `segment_ordinal` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Hand-written data conversion: a saved position is now the playback cursor
-- (segment key + ordinal). v5.0 PDF ("<page>:<ordinal>") and HTML
-- ("html:<location>:<ordinal>") tokens embed the ordinal; keep it with a NULL
-- key, which resolves by ordinal. EPUB locators and unrecognised legacy values
-- carry no ordinal and resume from the start of the document.
UPDATE `user_document_progress` SET `segment_ordinal` = CASE
	WHEN `reader_type` = 'pdf'
		AND `location` GLOB '[0-9]*:[0-9]*'
		AND `location` NOT GLOB '*[^0-9:]*'
		AND `location` NOT GLOB '*:*:*'
		AND length(substr(`location`, instr(`location`, ':') + 1)) <= 9
		THEN CAST(substr(`location`, instr(`location`, ':') + 1) AS integer)
	WHEN `reader_type` = 'html'
		AND `location` GLOB 'html:?*:[0-9]*'
		AND substr(`location`, 6) NOT GLOB '*:*:*'
		AND substr(substr(`location`, 6), instr(substr(`location`, 6), ':') + 1) NOT GLOB '*[^0-9]*'
		AND length(substr(substr(`location`, 6), instr(substr(`location`, 6), ':') + 1)) <= 9
		THEN CAST(substr(substr(`location`, 6), instr(substr(`location`, 6), ':') + 1) AS integer)
	ELSE 0
END;--> statement-breakpoint
ALTER TABLE `user_document_progress` DROP COLUMN `reader_type`;--> statement-breakpoint
ALTER TABLE `user_document_progress` DROP COLUMN `location`;