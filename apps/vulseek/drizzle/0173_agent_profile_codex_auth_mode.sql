ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "codexAuthMode" text DEFAULT 'api_key' NOT NULL;
