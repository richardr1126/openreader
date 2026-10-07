CREATE TABLE "user_document_bookmarks" (
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"segment_key" text NOT NULL,
	"segment_ordinal" integer NOT NULL,
	"label" text,
	"snippet" text DEFAULT '' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "user_document_bookmarks_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "author" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "user_document_progress" ADD COLUMN "segment_key" text;--> statement-breakpoint
ALTER TABLE "user_document_progress" ADD COLUMN "segment_ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_document_bookmarks" ADD CONSTRAINT "user_document_bookmarks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_document_bookmarks" ADD CONSTRAINT "user_document_bookmarks_document_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_document_bookmarks_user_document" ON "user_document_bookmarks" USING btree ("user_id","document_id");--> statement-breakpoint
-- Hand-written data conversion: a saved position is now the playback cursor
-- (segment key + ordinal). v5.0 PDF ("<page>:<ordinal>") and HTML
-- ("html:<location>:<ordinal>") tokens embed the ordinal; keep it with a NULL
-- key, which resolves by ordinal. EPUB locators and unrecognised legacy values
-- carry no ordinal and resume from the start of the document.
UPDATE "user_document_progress" SET "segment_ordinal" = CASE
	WHEN "reader_type" = 'pdf' AND "location" ~ '^[0-9]+:[0-9]{1,9}$'
		THEN split_part("location", ':', 2)::integer
	WHEN "reader_type" = 'html' AND "location" ~ '^html:[^:]+:[0-9]{1,9}$'
		THEN split_part("location", ':', 3)::integer
	ELSE 0
END;--> statement-breakpoint
ALTER TABLE "user_document_progress" DROP COLUMN "reader_type";--> statement-breakpoint
ALTER TABLE "user_document_progress" DROP COLUMN "location";