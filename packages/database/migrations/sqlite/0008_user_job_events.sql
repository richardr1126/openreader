CREATE TABLE `user_job_events` (
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`op_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `action`, `op_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_user_job_events_user_action_created` ON `user_job_events` (`user_id`,`action`,`created_at`);