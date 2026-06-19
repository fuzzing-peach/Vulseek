DO $$ BEGIN
 CREATE TYPE "public"."scanEvaluateStatus" AS ENUM('pending', 'running', 'completed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "evaluateConfig" jsonb DEFAULT '{"agentProfileId":"","groundTruthPath":""}'::jsonb NOT NULL;
ALTER TABLE "application" ALTER COLUMN "evaluateConfig" SET DEFAULT '{"agentProfileId":"","groundTruthPath":""}'::jsonb;
UPDATE "application"
SET "evaluateConfig" = jsonb_build_object(
	'agentProfileId',
	CASE
		WHEN jsonb_typeof("evaluateConfig") = 'object'
			AND "evaluateConfig" ? 'agentProfileId'
			AND jsonb_typeof("evaluateConfig"->'agentProfileId') = 'string'
			THEN "evaluateConfig"->'agentProfileId'
		ELSE to_jsonb(''::text)
	END,
	'groundTruthPath',
	to_jsonb(
		CASE
			WHEN jsonb_typeof("evaluateConfig") = 'object'
				THEN coalesce("evaluateConfig"->>'groundTruthPath', '')
			ELSE ''
		END
	)
);
CREATE TABLE IF NOT EXISTS "scan_evaluate_results" (
	"evaluateResultId" text PRIMARY KEY NOT NULL,
	"scanJobId" text NOT NULL,
	"applicationId" text NOT NULL,
	"status" "scanEvaluateStatus" DEFAULT 'pending' NOT NULL,
	"configSnapshot" jsonb DEFAULT '{"agentProfileId":"","groundTruthPath":""}'::jsonb NOT NULL,
	"realVulnCsvPath" text,
	"result" jsonb,
	"errorMessage" text,
	"startedAt" text,
	"finishedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
ALTER TABLE "scan_evaluate_results" ALTER COLUMN "configSnapshot" SET DEFAULT '{"agentProfileId":"","groundTruthPath":""}'::jsonb;
UPDATE "scan_evaluate_results"
SET "configSnapshot" = jsonb_build_object(
	'agentProfileId',
	CASE
		WHEN jsonb_typeof("configSnapshot") = 'object'
			AND "configSnapshot" ? 'agentProfileId'
			AND jsonb_typeof("configSnapshot"->'agentProfileId') = 'string'
			THEN "configSnapshot"->'agentProfileId'
		ELSE to_jsonb(''::text)
	END,
	'groundTruthPath',
	to_jsonb(
		CASE
			WHEN jsonb_typeof("configSnapshot") = 'object'
				THEN coalesce("configSnapshot"->>'groundTruthPath', '')
			ELSE ''
		END
	)
);
DO $$ BEGIN
 ALTER TABLE "scan_evaluate_results" ADD CONSTRAINT "scan_evaluate_results_scanJobId_scan_jobs_scanJobId_fk" FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "scan_evaluate_results" ADD CONSTRAINT "scan_evaluate_results_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "scan_evaluate_results_scan_job_idx" ON "scan_evaluate_results" USING btree ("scanJobId");
CREATE INDEX IF NOT EXISTS "scan_evaluate_results_application_idx" ON "scan_evaluate_results" USING btree ("applicationId");
CREATE INDEX IF NOT EXISTS "scan_evaluate_results_scan_job_created_idx" ON "scan_evaluate_results" USING btree ("scanJobId","createdAt");
