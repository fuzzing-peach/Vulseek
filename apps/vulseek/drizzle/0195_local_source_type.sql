DO $$ BEGIN
 ALTER TYPE "public"."sourceType" ADD VALUE IF NOT EXISTS 'local';
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "localPath" text;
