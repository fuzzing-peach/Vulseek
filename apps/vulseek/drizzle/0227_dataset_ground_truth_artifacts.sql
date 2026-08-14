ALTER TABLE "dataset_samples"
ADD COLUMN IF NOT EXISTS "groundTruthArtifacts" jsonb DEFAULT '[]'::jsonb NOT NULL;
