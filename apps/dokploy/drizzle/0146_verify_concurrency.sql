ALTER TABLE "application"
ADD COLUMN IF NOT EXISTS "verifyConcurrency" integer NOT NULL DEFAULT 1;

ALTER TABLE "compose"
ADD COLUMN IF NOT EXISTS "verifyConcurrency" integer NOT NULL DEFAULT 1;
