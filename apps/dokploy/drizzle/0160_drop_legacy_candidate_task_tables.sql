DROP TABLE IF EXISTS "candidate_analysis_tasks" CASCADE;
DROP TABLE IF EXISTS "candidate_verification_tasks" CASCADE;

ALTER TABLE "vulnerability_candidates"
	DROP COLUMN IF EXISTS "analysisThreadId",
	DROP COLUMN IF EXISTS "verifierThreadId";
