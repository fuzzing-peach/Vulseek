ALTER TABLE "vulnerability_candidates"
ADD COLUMN "currentStage" text DEFAULT 'analyzing' NOT NULL;
