ALTER TABLE "dataset_evaluations"
	ADD COLUMN IF NOT EXISTS "pipelineProfileId" text;

DO $$ BEGIN
	ALTER TABLE "dataset_evaluations"
		ADD CONSTRAINT "dataset_evaluations_pipelineProfileId_scan_pipeline_profiles_pipelineProfileId_fk"
		FOREIGN KEY ("pipelineProfileId") REFERENCES "scan_pipeline_profiles"("pipelineProfileId")
		ON DELETE set null;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
