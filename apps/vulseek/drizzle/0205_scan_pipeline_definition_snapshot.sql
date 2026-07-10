DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'scan_jobs'
			AND column_name = 'scanPipelineSnapshot'
	) AND NOT EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'scan_jobs'
			AND column_name = 'scanPipelineDefinitionSnapshot'
	) THEN
		ALTER TABLE "scan_jobs"
			RENAME COLUMN "scanPipelineSnapshot" TO "scanPipelineDefinitionSnapshot";
	END IF;
END $$;
