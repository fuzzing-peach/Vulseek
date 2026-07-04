ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "injectionPrompt" text NOT NULL DEFAULT '';
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "injectionPrompt" text NOT NULL DEFAULT '';
