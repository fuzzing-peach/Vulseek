ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "estimated_cost" real NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "estimated_cost" real;

CREATE TABLE IF NOT EXISTS "scan_job_cost_backfills" (
	"backfill_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"processed_count" integer NOT NULL DEFAULT 0,
	"skipped_count" integer NOT NULL DEFAULT 0,
	"skipped_tasks" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"updated_at" text NOT NULL
);
