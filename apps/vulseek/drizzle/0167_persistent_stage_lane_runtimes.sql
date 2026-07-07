CREATE TABLE IF NOT EXISTS "scan_stage_lane_runtimes" (
	"scanJobId" text NOT NULL,
	"stageName" text NOT NULL,
	"laneIndex" integer NOT NULL,
	"containerName" text,
	"threadId" text,
	"activeTaskId" text,
	"forkedFromTaskId" text,
	"forkedFromThreadId" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"lastExitTaskId" text,
	"lastExitAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "scan_stage_lane_runtimes_scanJobId_stageName_laneIndex_pk" PRIMARY KEY("scanJobId","stageName","laneIndex")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scan_stage_lane_runtimes" ADD CONSTRAINT "scan_stage_lane_runtimes_scanJobId_scan_jobs_scanJobId_fk"
 FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scan_stage_lane_runtimes" ADD CONSTRAINT "scan_stage_lane_runtimes_activeTaskId_tasks_taskId_fk"
 FOREIGN KEY ("activeTaskId") REFERENCES "public"."tasks"("taskId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scan_stage_lane_runtimes" ADD CONSTRAINT "scan_stage_lane_runtimes_forkedFromTaskId_tasks_taskId_fk"
 FOREIGN KEY ("forkedFromTaskId") REFERENCES "public"."tasks"("taskId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_stage_lane_scan_job_stage_idx" ON "scan_stage_lane_runtimes" USING btree ("scanJobId","stageName");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_stage_lane_active_task_idx" ON "scan_stage_lane_runtimes" USING btree ("activeTaskId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_stage_lane_container_idx" ON "scan_stage_lane_runtimes" USING btree ("containerName");
