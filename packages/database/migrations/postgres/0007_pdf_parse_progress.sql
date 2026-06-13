ALTER TABLE "documents" ADD COLUMN "parse_state" text;--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "parse_status";