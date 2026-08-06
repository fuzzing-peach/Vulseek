ALTER TABLE "dataset_profiles" ADD COLUMN IF NOT EXISTS "selectedSampleIds" jsonb NOT NULL DEFAULT '[]'::jsonb;
