DROP TABLE IF EXISTS `audiobook_chapters`;--> statement-breakpoint
DROP TABLE IF EXISTS `audiobooks`;--> statement-breakpoint
DROP TABLE IF EXISTS `tts_playback_sessions`;--> statement-breakpoint
DROP TABLE IF EXISTS `tts_segment_variants`;--> statement-breakpoint
DROP TABLE IF EXISTS `tts_segment_entries`;--> statement-breakpoint
DELETE FROM `scheduled_tasks` WHERE `key` = 'cleanup-legacy-tts-playback-cache';
