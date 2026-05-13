ALTER TYPE "public"."scanPhase" ADD VALUE IF NOT EXISTS 'canceled';

ALTER TYPE "public"."scanJobStatus" RENAME TO "scanJobStatus_old";

CREATE TYPE "public"."scanJobStatus" AS ENUM(
	'pending',
	'running',
	'finished',
	'canceled'
);

ALTER TABLE "scan_jobs"
	ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "scan_jobs"
	ALTER COLUMN "status" TYPE "public"."scanJobStatus"
	USING (
		CASE
			WHEN "status"::text = 'queued' THEN 'pending'::"public"."scanJobStatus"
			WHEN "status"::text IN ('scanning', 'analyzing', 'verifying') THEN 'running'::"public"."scanJobStatus"
			WHEN "status"::text = 'failed' AND "errorMessage" = 'Stopped manually' THEN 'canceled'::"public"."scanJobStatus"
			ELSE 'finished'::"public"."scanJobStatus"
		END
	);

ALTER TABLE "scan_jobs"
	ALTER COLUMN "status" SET DEFAULT 'pending';

DROP TYPE "public"."scanJobStatus_old";
