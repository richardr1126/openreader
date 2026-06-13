CREATE TABLE "tts_segments" (
	"segment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"reader_type" text NOT NULL,
	"document_version" bigint NOT NULL,
	"segment_index" integer NOT NULL,
	"locator_json" text,
	"settings_hash" text NOT NULL,
	"settings_json" jsonb NOT NULL,
	"text_hash" text NOT NULL,
	"text_length" integer DEFAULT 0 NOT NULL,
	"audio_key" text,
	"audio_format" text DEFAULT 'mp3' NOT NULL,
	"duration_ms" integer,
	"alignment_json" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	CONSTRAINT "tts_segments_segment_id_user_id_pk" PRIMARY KEY("segment_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "tts_segments" ADD CONSTRAINT "tts_segments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tts_segments_lookup" ON "tts_segments" USING btree ("user_id","document_id","document_version","settings_hash");--> statement-breakpoint
CREATE INDEX "idx_tts_segments_doc_index" ON "tts_segments" USING btree ("user_id","document_id","segment_index");