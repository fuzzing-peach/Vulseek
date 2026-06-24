ALTER TABLE "application" ALTER COLUMN "autoDeltaScan" SET DEFAULT false;
ALTER TABLE "compose" ALTER COLUMN "autoDeltaScan" SET DEFAULT false;

UPDATE "application"
SET "autoDeltaScan" = false
WHERE "autoDeltaScan" IS NULL;

UPDATE "compose"
SET "autoDeltaScan" = false
WHERE "autoDeltaScan" IS NULL;
