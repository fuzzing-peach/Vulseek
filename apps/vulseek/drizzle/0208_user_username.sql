ALTER TABLE "user_temp" ADD COLUMN "username" text;

DO $$
DECLARE
	user_record record;
	base_username text;
	candidate_username text;
	suffix integer;
BEGIN
	FOR user_record IN
		SELECT "id", "email" FROM "user_temp" ORDER BY "created_at" NULLS LAST, "id"
	LOOP
		base_username := regexp_replace(
			lower(split_part(user_record."email", '@', 1)),
			'[^a-z0-9_.]',
			'',
			'g'
		);
		base_username := left(base_username, 30);

		IF length(base_username) < 3 THEN
			IF length(base_username) > 0 THEN
				base_username := 'user_' || base_username;
			ELSE
				base_username := 'user';
			END IF;
		END IF;

		candidate_username := base_username;
		suffix := 0;
		WHILE EXISTS (
			SELECT 1 FROM "user_temp" WHERE "username" = candidate_username
		) LOOP
			suffix := suffix + 1;
			candidate_username := left(
				base_username,
				30 - length(suffix::text)
			) || suffix::text;
		END LOOP;

		UPDATE "user_temp"
		SET "username" = candidate_username
		WHERE "id" = user_record."id";
	END LOOP;
END $$;

ALTER TABLE "user_temp" ALTER COLUMN "username" SET NOT NULL;
ALTER TABLE "user_temp" ADD CONSTRAINT "user_temp_username_lowercase" CHECK ("username" = lower("username"));
ALTER TABLE "user_temp" ADD CONSTRAINT "user_temp_username_unique" UNIQUE("username");
