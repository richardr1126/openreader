CREATE TABLE "audiobook_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"document_version" bigint NOT NULL,
	"format" text NOT NULL,
	"speed" double precision NOT NULL,
	"chapter_index" integer,
	"settings_json" jsonb NOT NULL,
	"plan_object_key" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint
);
--> statement-breakpoint
ALTER TABLE "audiobook_requests" ADD CONSTRAINT "audiobook_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audiobook_requests" ADD CONSTRAINT "audiobook_requests_document_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audiobook_requests_user_document" ON "audiobook_requests" USING btree ("user_id","document_id");