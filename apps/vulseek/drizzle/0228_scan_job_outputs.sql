ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "outputs" jsonb DEFAULT '[]'::jsonb NOT NULL;
