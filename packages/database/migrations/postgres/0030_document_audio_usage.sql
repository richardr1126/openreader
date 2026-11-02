CREATE TABLE "document_audio_usage" (
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"audio_bytes" bigint DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"clear_lease_until" bigint DEFAULT 0 NOT NULL,
	"measured_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "document_audio_usage_user_id_document_id_pk" PRIMARY KEY("user_id","document_id"),
	CONSTRAINT "document_audio_usage_nonnegative" CHECK ("document_audio_usage"."audio_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_audio_usage" ADD CONSTRAINT "document_audio_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;