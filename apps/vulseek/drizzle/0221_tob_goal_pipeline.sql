ALTER TYPE "public"."scanType" ADD VALUE IF NOT EXISTS 'tob-goal';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tob_goal_candidates" (
	"scanJobId" text NOT NULL,
	"candidateId" text NOT NULL,
	"huntGoalId" text NOT NULL,
	"huntTaskId" text,
	"status" text DEFAULT 'discovered' NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" jsonb NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "tob_goal_candidates_scanJobId_candidateId_pk" PRIMARY KEY("scanJobId","candidateId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tob_goal_findings" (
	"scanJobId" text NOT NULL,
	"findingId" text NOT NULL,
	"sourceCandidateId" text NOT NULL,
	"huntGoalId" text NOT NULL,
	"status" text DEFAULT 'novel' NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" jsonb NOT NULL,
	"dedupRefs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "tob_goal_findings_scanJobId_findingId_pk" PRIMARY KEY("scanJobId","findingId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tob_goal_candidates" ADD CONSTRAINT "tob_goal_candidates_scanJobId_scan_jobs_scanJobId_fk" FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tob_goal_candidates" ADD CONSTRAINT "tob_goal_candidates_huntTaskId_tasks_taskId_fk" FOREIGN KEY ("huntTaskId") REFERENCES "public"."tasks"("taskId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tob_goal_findings" ADD CONSTRAINT "tob_goal_findings_scanJobId_scan_jobs_scanJobId_fk" FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tob_goal_candidates_scan_job_idx" ON "tob_goal_candidates" USING btree ("scanJobId","updatedAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tob_goal_candidates_status_idx" ON "tob_goal_candidates" USING btree ("scanJobId","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tob_goal_candidates_hunt_goal_idx" ON "tob_goal_candidates" USING btree ("scanJobId","huntGoalId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tob_goal_findings_scan_job_idx" ON "tob_goal_findings" USING btree ("scanJobId","updatedAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tob_goal_findings_candidate_idx" ON "tob_goal_findings" USING btree ("scanJobId","sourceCandidateId");
