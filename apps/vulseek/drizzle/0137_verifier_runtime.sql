ALTER TYPE "scanJobStatus" ADD VALUE IF NOT EXISTS 'verifying';

ALTER TABLE "vulnerability_candidates"
ADD COLUMN "verifierThreadId" text;

CREATE TABLE IF NOT EXISTS "verification_results" (
	"verificationResultId" text PRIMARY KEY NOT NULL,
	"scanJobId" text NOT NULL,
	"vulnerabilityCandidateId" text NOT NULL,
	"result" text NOT NULL,
	"reportPath" text,
	"issueDraftPath" text,
	"pocPath" text,
	"dockerfilePath" text,
	"runScriptPath" text,
	"runtimeSeconds" real,
	"threadId" text,
	"summary" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "verification_results_scanJobId_scan_jobs_scanJobId_fk"
		FOREIGN KEY ("scanJobId")
		REFERENCES "public"."scan_jobs"("scanJobId")
		ON DELETE cascade
		ON UPDATE no action,
	CONSTRAINT "verification_results_vulnerabilityCandidateId_vulnerability_candidates_vulnerabilityCandidateId_fk"
		FOREIGN KEY ("vulnerabilityCandidateId")
		REFERENCES "public"."vulnerability_candidates"("vulnerabilityCandidateId")
		ON DELETE cascade
		ON UPDATE no action
);
