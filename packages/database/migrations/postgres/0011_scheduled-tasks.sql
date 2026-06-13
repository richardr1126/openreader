CREATE TABLE "document_blob_leases" (
	"document_id" text PRIMARY KEY NOT NULL,
	"lease_owner" text NOT NULL,
	"lease_until_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_ms" bigint NOT NULL,
	"last_status" text DEFAULT 'idle' NOT NULL,
	"lease_owner" text,
	"last_run_at" bigint,
	"last_duration_ms" bigint,
	"last_error" text,
	"last_result_json" text,
	"next_run_at" bigint,
	"run_requested" boolean DEFAULT false NOT NULL,
	"running_since" bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "scheduled_tasks_interval_ms_positive" CHECK ("scheduled_tasks"."interval_ms" > 0)
);
