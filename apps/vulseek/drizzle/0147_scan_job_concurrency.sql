ALTER TABLE "user_temp"
ADD COLUMN IF NOT EXISTS "scanJobConcurrency" integer NOT NULL DEFAULT 1;
