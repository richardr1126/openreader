ALTER TABLE "user" ADD COLUMN "access_status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "admin_source" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
UPDATE "user" SET "admin_source" = 'managed' WHERE "is_admin" = true;
--> statement-breakpoint
INSERT INTO "admin_settings" ("key", "value_json", "source", "updated_at")
SELECT 'initialAdminBootstrapped', '{"version":1,"legacy":true}'::jsonb, 'admin', (extract(epoch from now()) * 1000)::bigint
WHERE EXISTS (SELECT 1 FROM "user" WHERE "is_admin" = true)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "admin_settings" ("key", "value_json", "source", "updated_at")
SELECT 'signupPolicy', CASE WHEN "value_json" = 'false'::jsonb THEN '"closed"'::jsonb ELSE '"open"'::jsonb END, "source", "updated_at"
FROM "admin_settings" WHERE "key" = 'enableUserSignups'
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
DELETE FROM "admin_settings" WHERE "key" = 'enableUserSignups';
