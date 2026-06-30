DROP TABLE IF EXISTS "audiobook_chapters" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "audiobooks" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tts_playback_sessions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tts_segment_variants" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tts_segment_entries" CASCADE;--> statement-breakpoint
DELETE FROM "scheduled_tasks" WHERE "key" = 'cleanup-legacy-tts-playback-cache';
