CREATE TABLE IF NOT EXISTS "datasets" (
	"datasetId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source" jsonb NOT NULL,
	"postCheckoutHook" jsonb DEFAULT '{"type":"none"}'::jsonb NOT NULL,
	"postCheckoutSchema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"postScanHook" jsonb DEFAULT '{"type":"none"}'::jsonb NOT NULL,
	"postEvaluationHook" jsonb DEFAULT '{"type":"none"}'::jsonb NOT NULL,
	"postScanSchema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"postEvaluationSchema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataset_profiles" (
	"profileId" text PRIMARY KEY NOT NULL,
	"datasetId" text NOT NULL,
	"profileKey" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"hostRoot" text NOT NULL,
	"sourceDigest" text,
	"checkoutImage" text,
	"checkoutImageDigest" text,
	"configSnapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"postCheckoutStatus" text DEFAULT 'pending' NOT NULL,
	"postCheckoutLog" text,
	"postCheckoutResult" jsonb,
	"errorMessage" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataset_samples" (
	"sampleId" text PRIMARY KEY NOT NULL,
	"profileId" text NOT NULL,
	"sampleKey" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"repositoryPath" text NOT NULL,
	"scannerInput" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evaluatorMetadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataset_evaluations" (
	"evaluationId" text PRIMARY KEY NOT NULL,
	"datasetId" text NOT NULL,
	"profileId" text NOT NULL,
	"name" text NOT NULL,
	"pipelineId" text NOT NULL,
	"sampleKeys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repetitions" integer DEFAULT 1 NOT NULL,
	"timeBudgetSeconds" integer,
	"scanRuntimeSettings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scanPipelineDefinitionSnapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"postEvaluationStatus" text DEFAULT 'pending' NOT NULL,
	"postEvaluationResult" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"errorMessage" text,
	"startedAt" text,
	"finishedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataset_evaluation_trials" (
	"trialId" text PRIMARY KEY NOT NULL,
	"evaluationId" text NOT NULL,
	"sampleId" text NOT NULL,
	"repetition" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scanJobId" text,
	"postScanStatus" text DEFAULT 'pending' NOT NULL,
	"postScanResult" jsonb,
	"durationMs" integer,
	"inputTokens" bigint DEFAULT 0 NOT NULL,
	"outputTokens" bigint DEFAULT 0 NOT NULL,
	"thoughtTokens" bigint DEFAULT 0 NOT NULL,
	"totalTokens" bigint DEFAULT 0 NOT NULL,
	"estimatedCost" real DEFAULT 0 NOT NULL,
	"result" jsonb,
	"errorMessage" text,
	"startedAt" text,
	"finishedAt" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "datasets" ADD CONSTRAINT "datasets_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dataset_profiles" ADD CONSTRAINT "dataset_profiles_dataset_fk" FOREIGN KEY ("datasetId") REFERENCES "public"."datasets"("datasetId") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dataset_samples" ADD CONSTRAINT "dataset_samples_profile_fk" FOREIGN KEY ("profileId") REFERENCES "public"."dataset_profiles"("profileId") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dataset_evaluations" ADD CONSTRAINT "dataset_evaluations_dataset_fk" FOREIGN KEY ("datasetId") REFERENCES "public"."datasets"("datasetId") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dataset_evaluations" ADD CONSTRAINT "dataset_evaluations_profile_fk" FOREIGN KEY ("profileId") REFERENCES "public"."dataset_profiles"("profileId") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dataset_evaluation_trials" ADD CONSTRAINT "dataset_evaluation_trials_evaluation_fk" FOREIGN KEY ("evaluationId") REFERENCES "public"."dataset_evaluations"("evaluationId") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dataset_evaluation_trials" ADD CONSTRAINT "dataset_evaluation_trials_sample_fk" FOREIGN KEY ("sampleId") REFERENCES "public"."dataset_samples"("sampleId") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "datasetEvaluationTrialId" text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_dataset_trial_fk" FOREIGN KEY ("datasetEvaluationTrialId") REFERENCES "public"."dataset_evaluation_trials"("trialId") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dataset_evaluation_trials" ADD CONSTRAINT "dataset_evaluation_trials_scan_job_fk" FOREIGN KEY ("scanJobId") REFERENCES "public"."scan_jobs"("scanJobId") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "datasets_organization_name_unique" ON "datasets" USING btree ("organizationId", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "datasets_organization_idx" ON "datasets" USING btree ("organizationId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dataset_profiles_dataset_key_unique" ON "dataset_profiles" USING btree ("datasetId", "profileKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_profiles_dataset_idx" ON "dataset_profiles" USING btree ("datasetId", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_profiles_status_idx" ON "dataset_profiles" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dataset_samples_profile_sample_key_unique" ON "dataset_samples" USING btree ("profileId", "sampleKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_samples_profile_idx" ON "dataset_samples" USING btree ("profileId", "ordinal");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_evaluations_dataset_idx" ON "dataset_evaluations" USING btree ("datasetId", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_evaluations_profile_idx" ON "dataset_evaluations" USING btree ("profileId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_evaluations_status_idx" ON "dataset_evaluations" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dataset_evaluation_trials_sample_repetition_unique" ON "dataset_evaluation_trials" USING btree ("evaluationId", "sampleId", "repetition");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_evaluation_trials_evaluation_idx" ON "dataset_evaluation_trials" USING btree ("evaluationId", "ordinal");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_evaluation_trials_sample_idx" ON "dataset_evaluation_trials" USING btree ("sampleId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_evaluation_trials_status_idx" ON "dataset_evaluation_trials" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dataset_evaluation_active_trial_unique" ON "dataset_evaluation_trials" USING btree ("evaluationId") WHERE "status" IN ('preparing', 'running', 'post_processing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_jobs_dataset_trial_idx" ON "scan_jobs" USING btree ("datasetEvaluationTrialId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scan_jobs_dataset_trial_unique" ON "scan_jobs" USING btree ("datasetEvaluationTrialId") WHERE "datasetEvaluationTrialId" IS NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_exactly_one_target" CHECK (num_nonnulls("applicationId", "composeId", "datasetEvaluationTrialId") = 1) NOT VALID;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
