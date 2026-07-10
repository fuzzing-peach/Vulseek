ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "pricing_provider" text;
ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "estimated_cost" double precision NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "estimated_cost" double precision;
