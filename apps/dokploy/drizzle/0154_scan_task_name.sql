ALTER TABLE "scan_repository_tasks"
ADD COLUMN IF NOT EXISTS "name" text;

ALTER TABLE "scan_module_tasks"
ADD COLUMN IF NOT EXISTS "name" text;

ALTER TABLE "scan_function_tasks"
ADD COLUMN IF NOT EXISTS "name" text;

ALTER TABLE "candidate_analysis_tasks"
ADD COLUMN IF NOT EXISTS "name" text;

ALTER TABLE "candidate_verification_tasks"
ADD COLUMN IF NOT EXISTS "name" text;
