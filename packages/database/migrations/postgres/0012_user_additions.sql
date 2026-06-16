CREATE TABLE "user_folders" (
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	CONSTRAINT "user_folders_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_onboarding" (
	"user_id" text PRIMARY KEY NOT NULL,
	"privacy_accepted_at_ms" bigint,
	"last_seen_app_version" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "folder_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "recently_opened_at" bigint;--> statement-breakpoint
ALTER TABLE "user_folders" ADD CONSTRAINT "user_folders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_onboarding" ADD CONSTRAINT "user_onboarding_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_folders_user_position" ON "user_folders" USING btree ("user_id","position");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_user_id_user_folders_id_user_id_fk" FOREIGN KEY ("folder_id","user_id") REFERENCES "public"."user_folders"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_documents_user_id_folder" ON "documents" USING btree ("user_id","folder_id");--> statement-breakpoint
CREATE INDEX "idx_documents_user_id_recently_opened" ON "documents" USING btree ("user_id","recently_opened_at");