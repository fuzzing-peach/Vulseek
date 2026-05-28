ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "codexHomePath" text DEFAULT '' NOT NULL;
