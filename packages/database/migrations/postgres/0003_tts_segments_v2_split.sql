CREATE TABLE "tts_segment_entries" (
	"segment_entry_id" text NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"reader_type" text NOT NULL,
	"document_version" bigint NOT NULL,
	"segment_index" integer NOT NULL,
	"segment_key" text,
	"locator_reader_rank" integer NOT NULL,
	"locator_reader_type" text NOT NULL,
	"locator_page" integer NOT NULL,
	"locator_spine_index" integer NOT NULL,
	"locator_spine_href" text NOT NULL,
	"locator_char_offset" integer NOT NULL,
	"locator_location" text NOT NULL,
	"locator_identity_key" text NOT NULL,
	"text_hash" text NOT NULL,
	"text_length" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	CONSTRAINT "tts_segment_entries_segment_entry_id_user_id_pk" PRIMARY KEY("segment_entry_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tts_segment_variants" (
	"segment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"segment_entry_id" text NOT NULL,
	"settings_hash" text NOT NULL,
	"settings_json" jsonb NOT NULL,
	"audio_key" text,
	"audio_format" text DEFAULT 'mp3' NOT NULL,
	"duration_ms" integer,
	"alignment_json" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	CONSTRAINT "tts_segment_variants_segment_id_user_id_pk" PRIMARY KEY("segment_id","user_id")
);
--> statement-breakpoint
DROP TABLE "tts_segments" CASCADE;--> statement-breakpoint
ALTER TABLE "tts_segment_entries" ADD CONSTRAINT "tts_segment_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tts_segment_variants" ADD CONSTRAINT "tts_segment_variants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tts_segment_variants" ADD CONSTRAINT "tts_segment_variants_segment_entry_id_user_id_tts_segment_entries_segment_entry_id_user_id_fk" FOREIGN KEY ("segment_entry_id","user_id") REFERENCES "public"."tts_segment_entries"("segment_entry_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tts_segment_entries_manifest_sort" ON "tts_segment_entries" USING btree ("user_id","document_id","document_version","locator_reader_rank","locator_spine_index","locator_char_offset","locator_spine_href","locator_page","locator_location","segment_index","locator_identity_key");--> statement-breakpoint
CREATE INDEX "idx_tts_segment_entries_manifest_group" ON "tts_segment_entries" USING btree ("user_id","document_id","document_version","segment_index","locator_identity_key");--> statement-breakpoint
CREATE INDEX "idx_tts_segment_entries_scope" ON "tts_segment_entries" USING btree ("user_id","document_id","document_version");--> statement-breakpoint
CREATE INDEX "idx_tts_segment_variants_entry" ON "tts_segment_variants" USING btree ("user_id","segment_entry_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_tts_segment_variants_status" ON "tts_segment_variants" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_tts_segment_variants_unique_settings" ON "tts_segment_variants" USING btree ("user_id","segment_entry_id","settings_hash");