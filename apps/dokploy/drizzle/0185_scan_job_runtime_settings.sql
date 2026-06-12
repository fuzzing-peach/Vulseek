ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "scanRuntimeSettings" jsonb DEFAULT '{}'::jsonb NOT NULL;
