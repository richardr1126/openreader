CREATE TABLE "storage_cleanups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text,
	"not_before_ms" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_storage_cleanups_not_before" ON "storage_cleanups" USING btree ("not_before_ms");--> statement-breakpoint
-- Settings and progress rows whose document was deleted were never removed.
-- Drop them so the new cascading foreign keys can be added.
DELETE FROM "document_settings" s WHERE NOT EXISTS (SELECT 1 FROM "documents" d WHERE d."id" = s."document_id" AND d."user_id" = s."user_id");--> statement-breakpoint
DELETE FROM "user_document_progress" p WHERE NOT EXISTS (SELECT 1 FROM "documents" d WHERE d."id" = p."document_id" AND d."user_id" = p."user_id");--> statement-breakpoint
ALTER TABLE "document_settings" ADD CONSTRAINT "document_settings_document_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_document_progress" ADD CONSTRAINT "user_document_progress_document_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;