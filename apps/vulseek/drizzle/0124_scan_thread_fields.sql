ALTER TABLE "scan_jobs"
ADD COLUMN "scanningThreadId" text;

ALTER TABLE "vulnerability_candidates"
ADD COLUMN "analyzingThreadId" text,
ADD COLUMN "debuggingThreadId" text,
ADD COLUMN "fuzzingThreadId" text;
