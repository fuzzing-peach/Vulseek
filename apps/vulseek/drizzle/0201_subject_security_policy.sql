ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "securityPolicy" text DEFAULT '' NOT NULL;
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "securityPolicy" text DEFAULT '' NOT NULL;
