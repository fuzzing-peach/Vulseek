ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "input_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "output_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "thought_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "total_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "cached_read_tokens" integer;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "cached_write_tokens" integer;

UPDATE "tasks"
SET
	"total_tokens" = COALESCE("total_tokens", "token_usage"),
	"cached_read_tokens" = COALESCE("cached_read_tokens", "cached_input_tokens")
WHERE
	"token_usage" IS NOT NULL
	OR "cached_input_tokens" IS NOT NULL;
