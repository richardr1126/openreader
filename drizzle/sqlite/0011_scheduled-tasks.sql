CREATE TABLE `scheduled_tasks` (
	`key` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_ms` integer NOT NULL,
	`last_status` text DEFAULT 'idle' NOT NULL,
	`last_run_at` integer,
	`last_duration_ms` integer,
	`last_error` text,
	`last_result_json` text,
	`next_run_at` integer,
	`run_requested` integer DEFAULT false NOT NULL,
	`running_since` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
