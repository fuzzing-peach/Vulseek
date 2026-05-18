ALTER TYPE "public"."taskStatus" ADD VALUE IF NOT EXISTS 'exited';
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "stageGroupInstanceId" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "exitReason" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "exitNote" text;
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "fuzzingBudgetSeconds" integer DEFAULT 600 NOT NULL;
--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "fuzzingBudgetSeconds" integer DEFAULT 600 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_stage_group_instances" (
	"groupInstanceId" text PRIMARY KEY NOT NULL,
	"scanJobId" text NOT NULL,
	"groupName" text NOT NULL,
	"leaderStageName" text NOT NULL,
	"leaderLaneIndex" integer NOT NULL,
	"leaderTaskId" text,
	"status" text DEFAULT 'active' NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_stage_group_lane_memberships" (
	"groupInstanceId" text NOT NULL,
	"stageName" text NOT NULL,
	"laneIndex" integer NOT NULL,
	"role" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "scan_stage_group_lane_memberships_groupInstanceId_stageName_pk" PRIMARY KEY("groupInstanceId","stageName")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scan_stage_group_instances" ADD CONSTRAINT "scan_stage_group_instances_scanJobId_scan_jobs_scanJobId_fk"
 FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scan_stage_group_instances" ADD CONSTRAINT "scan_stage_group_instances_leaderTaskId_tasks_taskId_fk"
 FOREIGN KEY ("leaderTaskId") REFERENCES "public"."tasks"("taskId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scan_stage_group_lane_memberships" ADD CONSTRAINT "scan_stage_group_lane_memberships_groupInstanceId_scan_stage_group_instances_groupInstanceId_fk"
 FOREIGN KEY ("groupInstanceId") REFERENCES "public"."scan_stage_group_instances"("groupInstanceId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_stage_group_instance_scan_job_group_idx" ON "scan_stage_group_instances" USING btree ("scanJobId","groupName");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_stage_group_instance_leader_idx" ON "scan_stage_group_instances" USING btree ("scanJobId","leaderStageName","leaderLaneIndex");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_stage_group_lane_membership_group_idx" ON "scan_stage_group_lane_memberships" USING btree ("groupInstanceId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_stage_group_lane_membership_stage_lane_idx" ON "scan_stage_group_lane_memberships" USING btree ("stageName","laneIndex");
