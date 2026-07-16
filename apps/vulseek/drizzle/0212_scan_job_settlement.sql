ALTER TYPE "public"."scanJobStatus" ADD VALUE IF NOT EXISTS 'finalizing';
ALTER TYPE "public"."scanJobStatus" ADD VALUE IF NOT EXISTS 'partially_finished';

ALTER TABLE "tasks"
	ADD COLUMN IF NOT EXISTS "downstreamDispatchStatus" text DEFAULT 'completed' NOT NULL,
	ADD COLUMN IF NOT EXISTS "downstreamRouteKey" text,
	ADD COLUMN IF NOT EXISTS "downstreamDispatchedAt" text,
	ADD COLUMN IF NOT EXISTS "dispatchKey" text;

ALTER TABLE "tasks"
	ALTER COLUMN "downstreamDispatchStatus" SET DEFAULT 'pending';

UPDATE "tasks"
SET "downstreamDispatchStatus" = CASE
	WHEN "status"::text IN ('completed', 'failed', 'exited', 'canceled') THEN 'completed'
	ELSE 'pending'
END;

CREATE INDEX IF NOT EXISTS "tasks_downstream_dispatch_status_idx"
	ON "tasks" ("scanJobId", "downstreamDispatchStatus");
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_dispatch_key_unique_idx"
	ON "tasks" ("dispatchKey")
	WHERE "dispatchKey" IS NOT NULL;

ALTER TABLE "scan_jobs"
	DROP COLUMN IF EXISTS "moduleTasksTotal",
	DROP COLUMN IF EXISTS "moduleTasksCompleted",
	DROP COLUMN IF EXISTS "moduleTasksFailed",
	DROP COLUMN IF EXISTS "functionTasksTotal",
	DROP COLUMN IF EXISTS "functionTasksCompleted",
	DROP COLUMN IF EXISTS "functionTasksFailed";
