ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "scanPipelineSnapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;
