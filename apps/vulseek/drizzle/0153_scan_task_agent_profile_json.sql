ALTER TABLE "scan_repository_tasks"
ADD COLUMN IF NOT EXISTS "agentProfile" jsonb;

ALTER TABLE "scan_module_tasks"
ADD COLUMN IF NOT EXISTS "agentProfile" jsonb;

ALTER TABLE "scan_function_tasks"
ADD COLUMN IF NOT EXISTS "agentProfile" jsonb;

ALTER TABLE "candidate_analysis_tasks"
ADD COLUMN IF NOT EXISTS "agentProfile" jsonb;

ALTER TABLE "candidate_verification_tasks"
ADD COLUMN IF NOT EXISTS "agentProfile" jsonb;
