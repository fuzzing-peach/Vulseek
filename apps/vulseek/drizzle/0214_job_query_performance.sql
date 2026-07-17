CREATE INDEX IF NOT EXISTS "tasks_scan_job_finished_at_idx"
	ON "tasks" USING btree ("scanJobId", (coalesce("completedAt", "updatedAt")) DESC, "taskId" DESC);
