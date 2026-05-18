ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "scanStageSettings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "scanStageSettings" jsonb DEFAULT '{}'::jsonb NOT NULL;
