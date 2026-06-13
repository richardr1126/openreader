ALTER TABLE "user_job_events" ADD CONSTRAINT "user_job_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
DELETE FROM "user_job_events" WHERE NOT EXISTS (
	SELECT 1 FROM "user" WHERE "user"."id" = "user_job_events"."user_id"
);--> statement-breakpoint
ALTER TABLE "user_job_events" VALIDATE CONSTRAINT "user_job_events_user_id_user_id_fk";