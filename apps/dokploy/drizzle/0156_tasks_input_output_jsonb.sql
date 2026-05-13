ALTER TABLE "tasks"
	ALTER COLUMN "input" TYPE jsonb
	USING CASE
		WHEN "input" IS NULL OR btrim("input") = '' THEN NULL
		ELSE "input"::jsonb
	END;

ALTER TABLE "tasks"
	ALTER COLUMN "output" TYPE jsonb
	USING CASE
		WHEN "output" IS NULL OR btrim("output") = '' THEN NULL
		ELSE "output"::jsonb
	END;
