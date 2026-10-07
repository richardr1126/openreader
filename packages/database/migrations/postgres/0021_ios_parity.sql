CREATE TABLE "user_document_bookmarks" (
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"reader_type" text NOT NULL,
	"location" text NOT NULL,
	"segment_key" text,
	"segment_ordinal" integer,
	"label" text,
	"snippet" text DEFAULT '' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "user_document_bookmarks_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "author" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "user_document_bookmarks" ADD CONSTRAINT "user_document_bookmarks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_document_bookmarks" ADD CONSTRAINT "user_document_bookmarks_document_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_document_bookmarks_user_document" ON "user_document_bookmarks" USING btree ("user_id","document_id");