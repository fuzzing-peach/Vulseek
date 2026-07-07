ALTER TYPE "scanJobStatus" RENAME VALUE 'mining' TO 'analysis';

ALTER TABLE "vulnerability_candidates"
RENAME COLUMN "miningThreadId" TO "analysisThreadId";
