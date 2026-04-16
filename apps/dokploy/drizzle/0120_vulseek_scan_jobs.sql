CREATE TYPE "public"."scanType" AS ENUM('delta', 'full');
CREATE TYPE "public"."scanJobStatus" AS ENUM('queued', 'running', 'completed', 'failed');
CREATE TYPE "public"."vulnerabilityCandidateStatus" AS ENUM('queued', 'running', 'completed', 'failed');

CREATE TABLE "scan_jobs" (
	"scanJobId" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT 'Scan Job' NOT NULL,
	"description" text,
	"scanType" "scanType" NOT NULL,
	"status" "scanJobStatus" DEFAULT 'queued' NOT NULL,
	"triggerSource" text DEFAULT 'manual' NOT NULL,
	"commitSha" text,
	"baseSha" text,
	"commitWindow" integer DEFAULT 3 NOT NULL,
	"applicationId" text,
	"composeId" text,
	"createdAt" text NOT NULL,
	"startedAt" text,
	"finishedAt" text,
	"errorMessage" text
);

CREATE TABLE "vulnerability_candidates" (
	"vulnerabilityCandidateId" text PRIMARY KEY NOT NULL,
	"scanJobId" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"filePath" text,
	"line" integer,
	"status" "vulnerabilityCandidateStatus" DEFAULT 'queued' NOT NULL,
	"confidence" integer,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);

CREATE TABLE "scan_findings" (
	"scanFindingId" text PRIMARY KEY NOT NULL,
	"vulnerabilityCandidateId" text NOT NULL,
	"title" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"detail" text,
	"createdAt" text NOT NULL
);

ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "vulnerability_candidates" ADD CONSTRAINT "vulnerability_candidates_scanJobId_scan_jobs_scanJobId_fk" FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "scan_findings" ADD CONSTRAINT "scan_findings_vulnerabilityCandidateId_vulnerability_candidates_vulnerabilityCandidateId_fk" FOREIGN KEY ("vulnerabilityCandidateId") REFERENCES "public"."vulnerability_candidates"("vulnerabilityCandidateId") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "scan_jobs_application_idx" ON "scan_jobs" USING btree ("applicationId");
CREATE INDEX "scan_jobs_compose_idx" ON "scan_jobs" USING btree ("composeId");
CREATE INDEX "scan_jobs_status_idx" ON "scan_jobs" USING btree ("status");
CREATE INDEX "scan_jobs_created_idx" ON "scan_jobs" USING btree ("createdAt");
CREATE INDEX "vulnerability_candidates_scan_job_idx" ON "vulnerability_candidates" USING btree ("scanJobId");
CREATE INDEX "scan_findings_candidate_idx" ON "scan_findings" USING btree ("vulnerabilityCandidateId");
