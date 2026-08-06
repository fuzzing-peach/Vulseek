DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dataset_samples' AND column_name = 'sampleKey') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dataset_samples' AND column_name = 'id') THEN
    ALTER TABLE "dataset_samples" RENAME COLUMN "sampleKey" TO "id";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dataset_samples' AND column_name = 'evaluatorMetadata') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dataset_samples' AND column_name = 'metadata') THEN
    ALTER TABLE "dataset_samples" RENAME COLUMN "evaluatorMetadata" TO "metadata";
  END IF;

  IF to_regclass('public.dataset_samples_profile_sample_key_unique') IS NOT NULL AND to_regclass('public.dataset_samples_profile_id_unique') IS NULL THEN
    ALTER INDEX "dataset_samples_profile_sample_key_unique" RENAME TO "dataset_samples_profile_id_unique";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dataset_evaluations' AND column_name = 'sampleKeys') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dataset_evaluations' AND column_name = 'sampleIds') THEN
    ALTER TABLE "dataset_evaluations" RENAME COLUMN "sampleKeys" TO "sampleIds";
  END IF;
END $$;
