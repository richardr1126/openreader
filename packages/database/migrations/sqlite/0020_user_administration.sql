ALTER TABLE `user` ADD `access_status` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user` ADD `admin_source` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user` ADD `deletion_requested_at` integer;
--> statement-breakpoint
UPDATE `user` SET `admin_source` = 'managed' WHERE `is_admin` = 1;
--> statement-breakpoint
INSERT INTO `admin_settings` (`key`, `value_json`, `source`, `updated_at`)
SELECT 'initialAdminBootstrapped', '{"version":1,"legacy":true}', 'admin', cast(unixepoch('subsecond') * 1000 as integer)
WHERE EXISTS (SELECT 1 FROM `user` WHERE `is_admin` = 1)
ON CONFLICT(`key`) DO NOTHING;
--> statement-breakpoint
INSERT INTO `admin_settings` (`key`, `value_json`, `source`, `updated_at`)
SELECT 'signupPolicy', CASE WHEN json_extract(`value_json`, '$') IN (0, 'false') THEN '"closed"' ELSE '"open"' END, `source`, `updated_at`
FROM `admin_settings` WHERE `key` = 'enableUserSignups'
ON CONFLICT(`key`) DO NOTHING;
--> statement-breakpoint
DELETE FROM `admin_settings` WHERE `key` = 'enableUserSignups';
