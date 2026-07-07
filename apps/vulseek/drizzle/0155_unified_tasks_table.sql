CREATE TYPE "public"."taskStatus" AS ENUM('queued', 'running', 'completed', 'failed');

CREATE TABLE IF NOT EXISTS "tasks" (
	"taskId" text PRIMARY KEY NOT NULL,
	"scanJobId" text NOT NULL,
	"parentTaskId" text,
	"name" text NOT NULL,
	"stageName" text NOT NULL,
	"status" "taskStatus" DEFAULT 'queued' NOT NULL,
	"priority" integer,
	"attempt" integer DEFAULT 0 NOT NULL,
	"agentProfile" jsonb,
	"containerName" text,
	"threadId" text,
	"input" jsonb,
	"output" jsonb,
	"rawOutput" text,
	"errorMessage" text,
	"startedAt" text,
	"completedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_scanJobId_scan_jobs_scanJobId_fk"
 FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parentTaskId_tasks_taskId_fk"
 FOREIGN KEY ("parentTaskId") REFERENCES "public"."tasks"("taskId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "tasks_scan_job_idx" ON "tasks" USING btree ("scanJobId");
CREATE INDEX IF NOT EXISTS "tasks_parent_task_idx" ON "tasks" USING btree ("parentTaskId");
CREATE INDEX IF NOT EXISTS "tasks_scan_job_status_idx" ON "tasks" USING btree ("scanJobId","status");
CREATE INDEX IF NOT EXISTS "tasks_scan_job_created_at_idx" ON "tasks" USING btree ("scanJobId","createdAt");
CREATE INDEX IF NOT EXISTS "tasks_stage_status_idx" ON "tasks" USING btree ("stageName","status");
CREATE INDEX IF NOT EXISTS "tasks_thread_idx" ON "tasks" USING btree ("threadId");
CREATE INDEX IF NOT EXISTS "tasks_container_idx" ON "tasks" USING btree ("containerName");
