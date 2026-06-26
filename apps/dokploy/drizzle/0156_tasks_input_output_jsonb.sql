DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'tasks' AND column_name = 'input'
		AND data_type <> 'jsonb'
	) THEN
		ALTER TABLE "tasks"
			ALTER COLUMN "input" TYPE jsonb
			USING CASE
				WHEN "input" IS NULL OR btrim("input"::text) = '' THEN NULL
				ELSE "input"::jsonb
			END;
	END IF;
END $$;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'tasks' AND column_name = 'output'
		AND data_type <> 'jsonb'
	) THEN
		ALTER TABLE "tasks"
			ALTER COLUMN "output" TYPE jsonb
			USING CASE
				WHEN "output" IS NULL OR btrim("output"::text) = '' THEN NULL
				ELSE "output"::jsonb
			END;
	END IF;
END $$;
