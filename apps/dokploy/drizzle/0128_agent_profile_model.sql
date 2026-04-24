ALTER TABLE "agent_profiles"
ADD COLUMN IF NOT EXISTS "model" text;

UPDATE "agent_profiles"
SET "model" = 'gpt-5.4'
WHERE "model" IS NULL AND "provider" = 'codex';

UPDATE "agent_profiles"
SET "model" = 'claude-sonnet-4-5'
WHERE "model" IS NULL AND "provider" = 'claude_code';

ALTER TABLE "agent_profiles"
ALTER COLUMN "model" SET NOT NULL;
