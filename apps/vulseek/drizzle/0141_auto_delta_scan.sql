ALTER TABLE "application"
ADD COLUMN IF NOT EXISTS "autoDeltaScan" boolean;

ALTER TABLE "compose"
ADD COLUMN IF NOT EXISTS "autoDeltaScan" boolean;

UPDATE "application"
SET "autoDeltaScan" = COALESCE("autoDeltaScan", "autoDeploy", true);

UPDATE "compose"
SET "autoDeltaScan" = COALESCE("autoDeltaScan", "autoDeploy", true);
