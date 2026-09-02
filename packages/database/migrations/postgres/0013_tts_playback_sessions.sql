CREATE TABLE "tts_playback_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"storage_user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"document_version" bigint NOT NULL,
	"reader_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"worker_op_id" text,
	"settings_hash" text NOT NULL,
	"settings_json" jsonb NOT NULL,
	"start_ordinal" integer DEFAULT 0 NOT NULL,
	"cursor_ordinal" integer DEFAULT 0 NOT NULL,
	"cursor_updated_at" bigint,
	"plan_object_key" text,
	"expires_at" bigint NOT NULL,
	"last_error" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tts_playback_sessions" ADD CONSTRAINT "tts_playback_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tts_playback_sessions_user_doc_settings" ON "tts_playback_sessions" USING btree ("user_id","document_id","document_version","settings_hash","start_ordinal");--> statement-breakpoint
CREATE INDEX "idx_tts_playback_sessions_expiry" ON "tts_playback_sessions" USING btree ("expires_at");