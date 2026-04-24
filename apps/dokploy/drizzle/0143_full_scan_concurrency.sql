ALTER TABLE "application"
ADD COLUMN IF NOT EXISTS "fullScanModuleConcurrency" integer NOT NULL DEFAULT 4;

ALTER TABLE "application"
ADD COLUMN IF NOT EXISTS "fullScanFunctionConcurrency" integer NOT NULL DEFAULT 4;

ALTER TABLE "compose"
ADD COLUMN IF NOT EXISTS "fullScanModuleConcurrency" integer NOT NULL DEFAULT 4;

ALTER TABLE "compose"
ADD COLUMN IF NOT EXISTS "fullScanFunctionConcurrency" integer NOT NULL DEFAULT 4;
