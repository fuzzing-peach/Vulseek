ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "authMode" text DEFAULT 'api_key' NOT NULL;
ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "homePath" text DEFAULT '' NOT NULL;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'agent_profiles'
			AND column_name = 'codexAuthMode'
	) THEN
		UPDATE "agent_profiles"
		SET
			"authMode" = CASE
				WHEN "codexAuthMode" = 'codex_home' THEN 'host_home'
				ELSE 'api_key'
			END,
			"homePath" = COALESCE("codexHomePath", '');
	END IF;
END $$;

ALTER TABLE "agent_profiles" DROP COLUMN IF EXISTS "codexAuthMode";
ALTER TABLE "agent_profiles" DROP COLUMN IF EXISTS "codexHomePath";
