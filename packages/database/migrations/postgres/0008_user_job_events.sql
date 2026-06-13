CREATE TABLE "user_job_events" (
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"op_id" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "user_job_events_user_id_action_op_id_pk" PRIMARY KEY("user_id","action","op_id")
);
--> statement-breakpoint
CREATE INDEX "idx_user_job_events_user_action_created" ON "user_job_events" USING btree ("user_id","action","created_at");