ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "input_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "output_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "thought_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "total_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "cached_read_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "cached_write_tokens" integer NOT NULL DEFAULT 0;

UPDATE "scan_jobs" AS "scan_job"
SET
	"input_tokens" = COALESCE("task_totals"."input_tokens", 0),
	"output_tokens" = COALESCE("task_totals"."output_tokens", 0),
	"thought_tokens" = COALESCE("task_totals"."thought_tokens", 0),
	"total_tokens" = COALESCE("task_totals"."total_tokens", 0),
	"cached_read_tokens" = COALESCE("task_totals"."cached_read_tokens", 0),
	"cached_write_tokens" = COALESCE("task_totals"."cached_write_tokens", 0)
FROM (
	SELECT
		"scanJobId",
		SUM(COALESCE("input_tokens", 0))::int AS "input_tokens",
		SUM(COALESCE("output_tokens", 0))::int AS "output_tokens",
		SUM(COALESCE("thought_tokens", 0))::int AS "thought_tokens",
		SUM(COALESCE("total_tokens", 0))::int AS "total_tokens",
		SUM(COALESCE("cached_read_tokens", 0))::int AS "cached_read_tokens",
		SUM(COALESCE("cached_write_tokens", 0))::int AS "cached_write_tokens"
	FROM "tasks"
	GROUP BY "scanJobId"
) AS "task_totals"
WHERE "scan_job"."scanJobId" = "task_totals"."scanJobId";
