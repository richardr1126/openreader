CREATE TABLE "scheduled_tasks" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_ms" bigint NOT NULL,
	"last_status" text DEFAULT 'idle' NOT NULL,
	"last_run_at" bigint,
	"last_duration_ms" bigint,
	"last_error" text,
	"last_result_json" text,
	"next_run_at" bigint,
	"run_requested" boolean DEFAULT false NOT NULL,
	"running_since" bigint,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
