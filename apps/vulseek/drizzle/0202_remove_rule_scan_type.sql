UPDATE "scan_jobs" SET "scanType" = 'full' WHERE "scanType"::text = 'rule';

ALTER TYPE "scanType" RENAME TO "scanType_old";
CREATE TYPE "scanType" AS ENUM ('delta', 'full');

ALTER TABLE "scan_jobs"
	ALTER COLUMN "scanType" TYPE "scanType"
	USING "scanType"::text::"scanType";

DROP TYPE "scanType_old";
