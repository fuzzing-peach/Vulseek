ALTER TABLE "application"
ADD COLUMN IF NOT EXISTS "analysisConcurrency" integer NOT NULL DEFAULT 2;

ALTER TABLE "compose"
ADD COLUMN IF NOT EXISTS "analysisConcurrency" integer NOT NULL DEFAULT 2;
