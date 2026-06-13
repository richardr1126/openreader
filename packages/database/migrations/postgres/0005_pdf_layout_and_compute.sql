CREATE TABLE "document_settings" (
	"document_id" text NOT NULL,
	"user_id" text NOT NULL,
	"data_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_updated_at_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	CONSTRAINT "document_settings_document_id_user_id_pk" PRIMARY KEY("document_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "parse_status" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "parsed_json_key" text;--> statement-breakpoint
ALTER TABLE "document_settings" ADD CONSTRAINT "document_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_document_settings_user_id" ON "document_settings" USING btree ("user_id");
