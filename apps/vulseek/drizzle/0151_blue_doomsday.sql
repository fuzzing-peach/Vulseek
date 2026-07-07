CREATE TABLE IF NOT EXISTS "scan_repository_tasks" (
  "scanRepositoryTaskId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE cascade,
  "status" "scanTaskStatus" DEFAULT 'queued' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "containerName" text,
  "threadId" text,
  "result" text,
  "repositoryScanMdPath" text,
  "repositoryScanJsonPath" text,
  "modulePlanJsonPath" text,
  "errorMessage" text,
  "startedAt" text,
  "completedAt" text,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL,
  CONSTRAINT "scan_repository_tasks_scanJobId_unique" UNIQUE("scanJobId")
);

ALTER TABLE "scan_module_tasks"
  ADD COLUMN IF NOT EXISTS "result" text;

ALTER TABLE "scan_function_tasks"
  ADD COLUMN IF NOT EXISTS "result" text;

ALTER TABLE "vulnerability_candidates"
  ADD COLUMN IF NOT EXISTS "scanFunctionTaskId" text;

ALTER TABLE "vulnerability_candidates"
  DROP CONSTRAINT IF EXISTS "vulnerability_candidates_scanFunctionTaskId_scan_function_tasks_scanFunctionTaskId_fk";

ALTER TABLE "vulnerability_candidates"
  ADD CONSTRAINT "vulnerability_candidates_scanFunctionTaskId_scan_function_tasks_scanFunctionTaskId_fk"
  FOREIGN KEY ("scanFunctionTaskId") REFERENCES "public"."scan_function_tasks"("scanFunctionTaskId")
  ON DELETE set null ON UPDATE no action;

INSERT INTO "scan_repository_tasks" (
  "scanRepositoryTaskId",
  "scanJobId",
  "status",
  "attempt",
  "errorMessage",
  "startedAt",
  "completedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  md5(random()::text || clock_timestamp()::text || sj."scanJobId"),
  sj."scanJobId",
  COALESCE(sj."repositoryTaskStatus", 'queued'::"scanTaskStatus"),
  0,
  NULL,
  sj."startedAt",
  sj."finishedAt",
  sj."createdAt",
  COALESCE(sj."finishedAt", sj."startedAt", sj."createdAt")
FROM "scan_jobs" sj
LEFT JOIN "scan_repository_tasks" srt
  ON srt."scanJobId" = sj."scanJobId"
WHERE srt."scanRepositoryTaskId" IS NULL;

CREATE TABLE IF NOT EXISTS "candidate_analysis_tasks" (
  "candidateAnalysisTaskId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE cascade,
  "vulnerabilityCandidateId" text NOT NULL REFERENCES "vulnerability_candidates"("vulnerabilityCandidateId") ON DELETE cascade,
  "status" "scanTaskStatus" DEFAULT 'queued' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "containerName" text,
  "threadId" text,
  "result" text,
  "confidence" real,
  "score" real,
  "reportPath" text,
  "runtimeSeconds" real,
  "summary" text,
  "errorMessage" text,
  "startedAt" text,
  "completedAt" text,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL,
  CONSTRAINT "candidate_analysis_tasks_vulnerabilityCandidateId_unique" UNIQUE("vulnerabilityCandidateId")
);

INSERT INTO "candidate_analysis_tasks" (
  "candidateAnalysisTaskId",
  "scanJobId",
  "vulnerabilityCandidateId",
  "status",
  "attempt",
  "threadId",
  "result",
  "confidence",
  "score",
  "reportPath",
  "runtimeSeconds",
  "summary",
  "startedAt",
  "completedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  ar."analysisResultId",
  ar."scanJobId",
  ar."vulnerabilityCandidateId",
  'completed'::"scanTaskStatus",
  0,
  ar."threadId",
  ar."result",
  ar."confidence",
  ar."score",
  ar."reportPath",
  ar."runtimeSeconds",
  ar."summary",
  ar."createdAt",
  ar."updatedAt",
  ar."createdAt",
  ar."updatedAt"
FROM "analysis_results" ar
LEFT JOIN "candidate_analysis_tasks" cat
  ON cat."candidateAnalysisTaskId" = ar."analysisResultId"
WHERE cat."candidateAnalysisTaskId" IS NULL;

CREATE TABLE IF NOT EXISTS "candidate_verification_tasks" (
  "candidateVerificationTaskId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE cascade,
  "vulnerabilityCandidateId" text NOT NULL REFERENCES "vulnerability_candidates"("vulnerabilityCandidateId") ON DELETE cascade,
  "status" "scanTaskStatus" DEFAULT 'queued' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "containerName" text,
  "threadId" text,
  "result" text,
  "isBug" boolean,
  "isSecurity" boolean,
  "confidence" real,
  "score" real,
  "reportPath" text,
  "issueDraftPath" text,
  "pocPath" text,
  "dockerfilePath" text,
  "runScriptPath" text,
  "runtimeSeconds" real,
  "summary" text,
  "errorMessage" text,
  "startedAt" text,
  "completedAt" text,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL,
  CONSTRAINT "candidate_verification_tasks_vulnerabilityCandidateId_unique" UNIQUE("vulnerabilityCandidateId")
);

INSERT INTO "candidate_verification_tasks" (
  "candidateVerificationTaskId",
  "scanJobId",
  "vulnerabilityCandidateId",
  "status",
  "attempt",
  "threadId",
  "result",
  "isBug",
  "isSecurity",
  "confidence",
  "score",
  "reportPath",
  "issueDraftPath",
  "pocPath",
  "dockerfilePath",
  "runScriptPath",
  "runtimeSeconds",
  "summary",
  "startedAt",
  "completedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  vr."verificationResultId",
  vr."scanJobId",
  vr."vulnerabilityCandidateId",
  'completed'::"scanTaskStatus",
  0,
  vr."threadId",
  vr."result",
  vr."isBug",
  vr."isSecurity",
  vr."confidence",
  vr."score",
  vr."reportPath",
  vr."issueDraftPath",
  vr."pocPath",
  vr."dockerfilePath",
  vr."runScriptPath",
  vr."runtimeSeconds",
  vr."summary",
  vr."createdAt",
  vr."updatedAt",
  vr."createdAt",
  vr."updatedAt"
FROM "verification_results" vr
LEFT JOIN "candidate_verification_tasks" cvt
  ON cvt."candidateVerificationTaskId" = vr."verificationResultId"
WHERE cvt."candidateVerificationTaskId" IS NULL;

DROP TABLE IF EXISTS "analysis_results";
DROP TABLE IF EXISTS "verification_results";
ALTER TABLE "scan_jobs" DROP COLUMN IF EXISTS "repositoryTaskStatus";
