PRAGMA foreign_keys=OFF;--> statement-breakpoint
DELETE FROM `user_job_events` WHERE NOT EXISTS (
	SELECT 1 FROM `user` WHERE `user`.`id` = `user_job_events`.`user_id`
);--> statement-breakpoint
CREATE TABLE `__new_user_job_events` (
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`op_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `action`, `op_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_job_events`("user_id", "action", "op_id", "created_at") SELECT "user_id", "action", "op_id", "created_at" FROM `user_job_events`;--> statement-breakpoint
DROP TABLE `user_job_events`;--> statement-breakpoint
ALTER TABLE `__new_user_job_events` RENAME TO `user_job_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_user_job_events_user_action_created` ON `user_job_events` (`user_id`,`action`,`created_at`);