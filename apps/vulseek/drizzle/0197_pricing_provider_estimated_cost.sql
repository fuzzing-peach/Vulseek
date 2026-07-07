ALTER TABLE "agent_profiles" ADD COLUMN "pricing_provider" text;
ALTER TABLE "scan_jobs" ADD COLUMN "estimated_cost" double precision NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD COLUMN "estimated_cost" double precision;
