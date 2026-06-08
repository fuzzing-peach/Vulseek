ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "input_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "output_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "thought_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "total_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "cached_read_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "cached_write_tokens" integer;

DO $$
DECLARE
	has_token_usage boolean;
	has_cached_input_tokens boolean;
BEGIN
	SELECT EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = current_schema()
			AND table_name = 'tasks'
			AND column_name = 'token_usage'
	) INTO has_token_usage;

	SELECT EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = current_schema()
			AND table_name = 'tasks'
			AND column_name = 'cached_input_tokens'
	) INTO has_cached_input_tokens;

	IF has_token_usage THEN
		UPDATE "tasks"
		SET "total_tokens" = COALESCE("total_tokens", "token_usage")
		WHERE "token_usage" IS NOT NULL;
	END IF;

	IF has_cached_input_tokens THEN
		UPDATE "tasks"
		SET "cached_read_tokens" = COALESCE("cached_read_tokens", "cached_input_tokens")
		WHERE "cached_input_tokens" IS NOT NULL;
	END IF;
END $$;
