ALTER TABLE "tasks" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."taskStatus" RENAME TO "taskStatus_old";--> statement-breakpoint
CREATE TYPE "public"."taskStatus" AS ENUM('pending', 'launching', 'running', 'completed', 'failed');--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" TYPE "public"."taskStatus" USING (
	CASE
		WHEN "status"::text = 'queued' THEN 'pending'
		ELSE "status"::text
	END
)::"public"."taskStatus";--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
DROP TYPE "public"."taskStatus_old";
