ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "containerIndex" integer;
CREATE INDEX IF NOT EXISTS "tasks_container_index_idx" ON "tasks" ("scanJobId", "stageName", "containerIndex");
