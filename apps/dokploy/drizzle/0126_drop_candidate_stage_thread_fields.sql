ALTER TABLE "vulnerability_candidates"
DROP COLUMN IF EXISTS "analyzingThreadId",
DROP COLUMN IF EXISTS "debuggingThreadId",
DROP COLUMN IF EXISTS "fuzzingThreadId";
