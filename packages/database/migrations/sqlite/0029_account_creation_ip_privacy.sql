ALTER TABLE `compute_limit_admissions` DROP COLUMN `device_scope_key`;--> statement-breakpoint
ALTER TABLE `compute_limit_admissions` DROP COLUMN `ip_scope_key`;--> statement-breakpoint
UPDATE session SET ip_address = NULL;--> statement-breakpoint
DELETE FROM compute_limit_buckets WHERE scope_type IN ('ip', 'anonymous_device');
