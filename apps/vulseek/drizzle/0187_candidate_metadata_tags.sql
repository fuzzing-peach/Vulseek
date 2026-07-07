CREATE TABLE IF NOT EXISTS "candidate_metadata" (
	"vulnerabilityCandidateId" text NOT NULL,
	"scanJobId" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "candidate_metadata_scanJobId_vulnerabilityCandidateId_pk" PRIMARY KEY("scanJobId","vulnerabilityCandidateId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_tags" (
	"name" text PRIMARY KEY NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_metadata" ADD CONSTRAINT "candidate_metadata_scanJobId_scan_jobs_scanJobId_fk" FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_metadata_scan_job_idx" ON "candidate_metadata" USING btree ("scanJobId");
