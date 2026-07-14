ALTER TABLE "tasks" ADD COLUMN "vulnerabilityCandidateId" text;

CREATE TABLE "candidate_result_projections" (
	"scanJobId" text NOT NULL,
	"vulnerabilityCandidateId" text NOT NULL,
	"analysisTaskId" text,
	"analysisOutput" jsonb,
	"analysisResult" text,
	"analysisRank" integer,
	"analysisResultAt" text,
	"verificationTaskId" text,
	"verificationOutput" jsonb,
	"verificationResult" text,
	"verificationRank" integer,
	"verificationResultAt" text,
	"triageTaskId" text,
	"triageOutput" jsonb,
	"triageResult" text,
	"triageRank" integer,
	"triageResultAt" text,
	"latestResultAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "candidate_result_projections_pkey" PRIMARY KEY("scanJobId", "vulnerabilityCandidateId"),
	CONSTRAINT "candidate_result_projection_candidate_fk" FOREIGN KEY ("scanJobId", "vulnerabilityCandidateId") REFERENCES "vulnerability_candidates"("scanJobId", "vulnerabilityCandidateId") ON DELETE CASCADE
);

CREATE TABLE "candidate_result_projection_backfills" (
	"backfillId" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"processedCount" integer DEFAULT 0 NOT NULL,
	"skippedCount" integer DEFAULT 0 NOT NULL,
	"skippedTasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"errorMessage" text,
	"startedAt" text,
	"completedAt" text,
	"updatedAt" text NOT NULL
);

CREATE INDEX "tasks_scan_job_candidate_idx" ON "tasks" USING btree ("scanJobId", "vulnerabilityCandidateId", "stageName", "createdAt");
CREATE INDEX "candidate_result_projection_scan_job_idx" ON "candidate_result_projections" USING btree ("scanJobId");
CREATE INDEX "candidate_result_projection_analysis_idx" ON "candidate_result_projections" USING btree ("scanJobId", "analysisResult");
CREATE INDEX "candidate_result_projection_verification_idx" ON "candidate_result_projections" USING btree ("scanJobId", "verificationResult");
CREATE INDEX "candidate_result_projection_triage_idx" ON "candidate_result_projections" USING btree ("scanJobId", "triageResult");
CREATE INDEX "candidate_result_projection_latest_idx" ON "candidate_result_projections" USING btree ("scanJobId", "latestResultAt");

INSERT INTO "candidate_result_projection_backfills" ("backfillId", "status", "updatedAt")
VALUES ('v1', 'pending', now()::text)
ON CONFLICT ("backfillId") DO NOTHING;
