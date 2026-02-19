CREATE TABLE "audiobook_chapters" (
	"id" text NOT NULL,
	"book_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chapter_index" integer NOT NULL,
	"title" text NOT NULL,
	"duration" real DEFAULT 0,
	"file_path" text NOT NULL,
	"format" text NOT NULL,
	CONSTRAINT "audiobook_chapters_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "audiobooks" (
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"description" text,
	"cover_path" text,
	"duration" real DEFAULT 0,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	CONSTRAINT "audiobooks_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "document_previews" (
	"document_id" text NOT NULL,
	"namespace" text DEFAULT '' NOT NULL,
	"variant" text DEFAULT 'card-240-jpeg' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source_last_modified_ms" bigint NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text DEFAULT 'image/jpeg' NOT NULL,
	"width" integer DEFAULT 240 NOT NULL,
	"height" integer,
	"byte_size" bigint,
	"etag" text,
	"lease_owner" text,
	"lease_until_ms" bigint DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at_ms" bigint DEFAULT 0 NOT NULL,
	"updated_at_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "document_previews_document_id_namespace_variant_pk" PRIMARY KEY("document_id","namespace","variant")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" bigint NOT NULL,
	"last_modified" bigint NOT NULL,
	"file_path" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	CONSTRAINT "documents_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_document_progress" (
	"user_id" text NOT NULL,
	"document_id" text NOT NULL,
	"reader_type" text NOT NULL,
	"location" text NOT NULL,
	"progress" real,
	"client_updated_at_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	CONSTRAINT "user_document_progress_user_id_document_id_pk" PRIMARY KEY("user_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"data_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_updated_at_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint
);
--> statement-breakpoint
CREATE TABLE "user_tts_chars" (
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"char_count" bigint DEFAULT 0,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint,
	CONSTRAINT "user_tts_chars_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"is_anonymous" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audiobook_chapters" ADD CONSTRAINT "audiobook_chapters_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audiobook_chapters" ADD CONSTRAINT "audiobook_chapters_book_id_user_id_audiobooks_id_user_id_fk" FOREIGN KEY ("book_id","user_id") REFERENCES "public"."audiobooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audiobooks" ADD CONSTRAINT "audiobooks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_document_progress" ADD CONSTRAINT "user_document_progress_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_document_previews_status_lease" ON "document_previews" USING btree ("status","lease_until_ms");--> statement-breakpoint
CREATE INDEX "idx_documents_user_id" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_documents_user_id_last_modified" ON "documents" USING btree ("user_id","last_modified");--> statement-breakpoint
CREATE INDEX "idx_user_document_progress_user_id_updated_at" ON "user_document_progress" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_user_tts_chars_date" ON "user_tts_chars" USING btree ("date");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");