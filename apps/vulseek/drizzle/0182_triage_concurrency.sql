ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "triageConcurrency" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "triageConcurrency" integer NOT NULL DEFAULT 1;
