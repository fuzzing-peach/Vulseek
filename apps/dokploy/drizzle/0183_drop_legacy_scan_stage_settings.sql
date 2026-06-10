UPDATE "application"
SET "scanStageSettings" = COALESCE("scanStageSettings", '{}'::jsonb) || jsonb_build_object(
  'repository-scan', jsonb_build_object('agentProfileId', COALESCE("scanAgentProfileId", "agentProfileId"), 'concurrency', 1) || COALESCE("scanStageSettings"->'repository-scan', '{}'::jsonb),
  'module-scan', jsonb_build_object('agentProfileId', COALESCE("scanAgentProfileId", "agentProfileId"), 'concurrency', "fullScanModuleConcurrency") || COALESCE("scanStageSettings"->'module-scan', '{}'::jsonb),
  'function-scan', jsonb_build_object('agentProfileId', COALESCE("scanAgentProfileId", "agentProfileId"), 'concurrency', "fullScanFunctionConcurrency") || COALESCE("scanStageSettings"->'function-scan', '{}'::jsonb),
  'analyze', jsonb_build_object('agentProfileId', COALESCE("analysisAgentProfileId", "agentProfileId"), 'concurrency', "analysisConcurrency") || COALESCE("scanStageSettings"->'analyze', '{}'::jsonb),
  'build-fuzzer', jsonb_build_object('agentProfileId', COALESCE("analysisAgentProfileId", "agentProfileId"), 'concurrency', "analysisConcurrency") || COALESCE("scanStageSettings"->'build-fuzzer', '{}'::jsonb),
  'run-fuzzer', jsonb_build_object('agentProfileId', COALESCE("analysisAgentProfileId", "agentProfileId"), 'concurrency', "analysisConcurrency") || COALESCE("scanStageSettings"->'run-fuzzer', '{}'::jsonb),
  'criticize', jsonb_build_object('agentProfileId', COALESCE("analysisAgentProfileId", "agentProfileId"), 'concurrency', "analysisConcurrency") || COALESCE("scanStageSettings"->'criticize', '{}'::jsonb),
  'verify', jsonb_build_object('agentProfileId', COALESCE("verifierAgentProfileId", "agentProfileId"), 'concurrency', "verifyConcurrency") || COALESCE("scanStageSettings"->'verify', '{}'::jsonb),
  'triage', jsonb_build_object('agentProfileId', COALESCE("verifierAgentProfileId", "agentProfileId"), 'concurrency', "triageConcurrency") || COALESCE("scanStageSettings"->'triage', '{}'::jsonb)
);
--> statement-breakpoint
UPDATE "compose"
SET "scanStageSettings" = COALESCE("scanStageSettings", '{}'::jsonb) || jsonb_build_object(
  'repository-scan', jsonb_build_object('agentProfileId', "scanAgentProfileId", 'concurrency', 1) || COALESCE("scanStageSettings"->'repository-scan', '{}'::jsonb),
  'module-scan', jsonb_build_object('agentProfileId', "scanAgentProfileId", 'concurrency', "fullScanModuleConcurrency") || COALESCE("scanStageSettings"->'module-scan', '{}'::jsonb),
  'function-scan', jsonb_build_object('agentProfileId', "scanAgentProfileId", 'concurrency', "fullScanFunctionConcurrency") || COALESCE("scanStageSettings"->'function-scan', '{}'::jsonb),
  'analyze', jsonb_build_object('agentProfileId', "analysisAgentProfileId", 'concurrency', "analysisConcurrency") || COALESCE("scanStageSettings"->'analyze', '{}'::jsonb),
  'build-fuzzer', jsonb_build_object('agentProfileId', "analysisAgentProfileId", 'concurrency', "analysisConcurrency") || COALESCE("scanStageSettings"->'build-fuzzer', '{}'::jsonb),
  'run-fuzzer', jsonb_build_object('agentProfileId', "analysisAgentProfileId", 'concurrency', "analysisConcurrency") || COALESCE("scanStageSettings"->'run-fuzzer', '{}'::jsonb),
  'criticize', jsonb_build_object('agentProfileId', "analysisAgentProfileId", 'concurrency', "analysisConcurrency") || COALESCE("scanStageSettings"->'criticize', '{}'::jsonb),
  'verify', jsonb_build_object('agentProfileId', "verifierAgentProfileId", 'concurrency', "verifyConcurrency") || COALESCE("scanStageSettings"->'verify', '{}'::jsonb),
  'triage', jsonb_build_object('agentProfileId', "verifierAgentProfileId", 'concurrency', "triageConcurrency") || COALESCE("scanStageSettings"->'triage', '{}'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "agentProfileId";
--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "scanAgentProfileId";
--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "analysisAgentProfileId";
--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "verifierAgentProfileId";
--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "analysisConcurrency";
--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "verifyConcurrency";
--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "triageConcurrency";
--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "fullScanModuleConcurrency";
--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "fullScanFunctionConcurrency";
--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "scanAgentProfileId";
--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "analysisAgentProfileId";
--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "verifierAgentProfileId";
--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "analysisConcurrency";
--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "verifyConcurrency";
--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "triageConcurrency";
--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "fullScanModuleConcurrency";
--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "fullScanFunctionConcurrency";
