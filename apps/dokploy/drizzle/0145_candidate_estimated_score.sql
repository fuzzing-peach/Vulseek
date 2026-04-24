ALTER TABLE "vulnerability_candidates"
ADD COLUMN IF NOT EXISTS "score" real;

ALTER TABLE "analysis_results"
ADD COLUMN IF NOT EXISTS "score" real;

ALTER TABLE "verification_results"
ADD COLUMN IF NOT EXISTS "score" real;
